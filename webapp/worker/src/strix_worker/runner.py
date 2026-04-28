"""Run a single scan: spawn Strix, tail its event stream, write events back to Supabase."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shlex
from pathlib import Path
from typing import Any

from .config import WorkerConfig
from .credentials import materialize_credentials
from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


SCAN_ARTIFACTS_BUCKET = "scan-artifacts"


async def run_scan(scan_id: str, cfg: WorkerConfig, sb: WorkerSupabase) -> None:
    """Drive a single scan end to end. Always finalizes the scan row, even on error."""
    logger.info("picking up scan %s", scan_id)

    try:
        scan = sb.fetch_scan(scan_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("failed to fetch scan %s", scan_id)
        # We can't update the scan row if we can't read it — bail.
        return

    # Defensive: if someone else already started this scan, skip.
    if scan.get("status") not in ("queued", "running"):
        logger.info("scan %s already %s, skipping", scan_id, scan.get("status"))
        return

    org_id = scan["org_id"]
    targets = scan.get("scan_targets") or []
    integrations = [si["integrations"] for si in (scan.get("scan_integrations") or [])]

    sb.start_scan(scan_id)

    exit_code: int | None = None
    error_message: str | None = None
    final_status = "failed"

    try:
        with materialize_credentials(sb, scan_id, integrations) as creds:
            llm_provider, llm_api_key = _resolve_llm(cfg, sb, scan)

            env = _build_env(cfg, scan, creds.env, llm_provider, llm_api_key)
            cmd = _build_cmd(cfg, scan, targets)

            logger.info("running: %s", " ".join(shlex.quote(c) for c in cmd))
            sb.emit_event(
                scan_id,
                "scan.command",
                {"cmd": cmd, "env_keys": sorted(env.keys())},
            )

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                env={**os.environ, **env},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=_make_run_workdir(scan_id),
            )

            stdout_task = asyncio.create_task(_stream_logs(sb, scan_id, proc.stdout, "stdout"))
            stderr_task = asyncio.create_task(_stream_logs(sb, scan_id, proc.stderr, "stderr"))

            exit_code = await proc.wait()
            await asyncio.gather(stdout_task, stderr_task)

        # Strix's exit code convention: 0 = completed with no findings,
        # 2 = completed with findings. Anything else is a real failure.
        if exit_code in (0, 2):
            final_status = "completed"
        else:
            final_status = "failed"
            error_message = f"strix exited with code {exit_code}"

        # Upload run artifacts (events.jsonl, vuln md, final report) from the scan workdir.
        await _upload_run_artifacts(sb, scan_id, org_id)

    except Exception as e:  # noqa: BLE001
        logger.exception("scan %s failed", scan_id)
        error_message = str(e)
        final_status = "failed"

    finally:
        sb.finish_scan(
            scan_id,
            final_status,
            exit_code=exit_code,
            error_message=error_message,
        )
        logger.info("scan %s done status=%s exit_code=%s", scan_id, final_status, exit_code)


# ============================================================
# Helpers
# ============================================================

def _resolve_llm(
    cfg: WorkerConfig, sb: WorkerSupabase, scan: dict[str, Any]
) -> tuple[str, str]:
    """Pick the LLM provider + key for this scan: per-scan > per-org > worker default."""
    provider = scan.get("llm_provider") or cfg.default_strix_llm
    if not provider:
        raise RuntimeError("no LLM provider configured (scan, org, or worker)")

    org_key = sb.decrypt_org_llm_key(scan["id"])
    api_key = org_key or cfg.default_llm_api_key
    if not api_key:
        raise RuntimeError("no LLM API key available")

    return provider, api_key


def _build_env(
    cfg: WorkerConfig,
    scan: dict[str, Any],
    cred_env: dict[str, str],
    llm_provider: str,
    llm_api_key: str,
) -> dict[str, str]:
    env = {
        "STRIX_LLM": llm_provider,
        "LLM_API_KEY": llm_api_key,
        "STRIX_IMAGE": cfg.strix_image,
        # Disable cli-config persistence — we never want a server worker to write ~/.strix/cli-config.json
        "STRIX_PERSIST_CONFIG": "false",
        # Run logs directory; we'll harvest after exit.
        "PYTHONUNBUFFERED": "1",
    }
    env.update(cred_env)
    return env


def _build_cmd(cfg: WorkerConfig, scan: dict[str, Any], targets: list[dict[str, Any]]) -> list[str]:
    cmd = [cfg.strix_bin, "-n", "-m", scan["scan_mode"]]

    if scan.get("scope_mode") and scan["scope_mode"] != "auto":
        cmd += ["--scope-mode", scan["scope_mode"]]
    if scan.get("diff_base"):
        cmd += ["--diff-base", scan["diff_base"]]

    for target in targets:
        cmd += ["-t", target["value"]]

    if instr := scan.get("instruction_text"):
        cmd += ["--instruction", instr]

    return cmd


def _make_run_workdir(scan_id: str) -> str:
    workdir = Path("/tmp/strix-runs") / scan_id
    workdir.mkdir(parents=True, exist_ok=True)
    return str(workdir)


async def _stream_logs(
    sb: WorkerSupabase,
    scan_id: str,
    stream: asyncio.StreamReader | None,
    label: str,
) -> None:
    """Stream stdout/stderr lines into scan_events as 'log' events.

    Strix's structured event stream lives in events.jsonl on disk, which we upload at the end.
    These log lines are a coarse live channel — fine for "show me what's happening now" UX.
    """
    if stream is None:
        return
    while True:
        try:
            line = await stream.readline()
        except Exception:  # noqa: BLE001
            break
        if not line:
            break
        try:
            text = line.decode(errors="replace").rstrip("\n")
            if text:
                sb.emit_event(scan_id, "log", {"stream": label, "line": text})
        except Exception as e:  # noqa: BLE001
            logger.warning("failed to emit log line: %s", e)


async def _upload_run_artifacts(sb: WorkerSupabase, scan_id: str, org_id: str) -> None:
    """Upload artifacts produced by Strix to Supabase Storage.

    Strix writes to <cwd>/strix_runs/<run_name>/. We set cwd above to a per-scan tmp dir,
    so we can find the run dir there.
    """
    workdir = Path(f"/tmp/strix-runs/{scan_id}/strix_runs")
    if not workdir.exists():
        logger.info("no strix_runs dir for scan %s; skipping artifact upload", scan_id)
        return

    prefix = f"{org_id}/{scan_id}"
    for run_dir in workdir.iterdir():
        if not run_dir.is_dir():
            continue
        for path in run_dir.rglob("*"):
            if path.is_file():
                rel = path.relative_to(run_dir)
                key = f"{prefix}/{rel}"
                try:
                    contents = path.read_bytes()
                    sb.upload_artifact(SCAN_ARTIFACTS_BUCKET, key, contents)
                except Exception as e:  # noqa: BLE001
                    logger.warning("failed to upload %s: %s", key, e)

        # Parse vulnerability markdown files into structured findings.
        vulns_dir = run_dir / "vulnerabilities"
        if vulns_dir.exists():
            for vuln_file in sorted(vulns_dir.glob("vuln-*.md")):
                _ingest_finding(sb, scan_id, vuln_file)


def _extract_meta_field(lines: list[str], label: str) -> str | None:
    """Pull a value out of `**Label:** value` lines in Strix's vuln markdown."""
    needle = f"**{label}:**".lower()
    for line in lines:
        stripped = line.strip()
        if stripped.lower().startswith(needle):
            value = stripped[len(needle):].strip().strip("*").strip()
            return value or None
    return None


def _compute_fingerprint(*, cwe: str | None, endpoint: str | None, target: str | None, title: str) -> str:
    """Stable hash so the same issue across scans collapses to one row.

    Inputs are intentionally loose: CWE + (endpoint or target) + a normalised
    title prefix. Two LLM rewordings of the same finding produce the same
    fingerprint as long as the CWE and locator are stable.
    """
    norm_title = re.sub(r"\s+", " ", title.lower().strip())[:80]
    norm_loc = (endpoint or target or "").lower().strip()
    norm_cwe = (cwe or "").upper().strip()
    payload = f"{norm_cwe}|{norm_loc}|{norm_title}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _ingest_finding(sb: WorkerSupabase, scan_id: str, vuln_file: Path) -> None:
    """Convert a Strix vulnerability markdown into a row in `findings`.

    Beyond the title/severity, we now extract every structured field Strix
    writes in its `**Field:** value` header block (CWE, CVE, CVSS, target,
    endpoint, method) so the DB row carries searchable metadata and so the
    fingerprint can be computed from CWE + endpoint + title.
    """
    try:
        text = vuln_file.read_text()
        lines = text.splitlines()
        title = next((l[2:].strip() for l in lines if l.startswith("# ")), vuln_file.stem)

        # Severity line looks like `**Severity:** HIGH` (per Strix's tracer).
        # The earlier `split(":", 1)` split inside `**Severity:**` and produced
        # `"** high"`, which fails the DB severity-enum check and gets silently
        # swallowed. We now match on the literal prefix and strip leftover bold.
        sev_raw = _extract_meta_field(lines, "Severity")
        severity = (sev_raw or "info").lower()

        cvss_raw = _extract_meta_field(lines, "CVSS")
        try:
            cvss = float(cvss_raw) if cvss_raw else None
        except ValueError:
            cvss = None

        cwe = _extract_meta_field(lines, "CWE")
        cve = _extract_meta_field(lines, "CVE")
        target = _extract_meta_field(lines, "Target")
        endpoint = _extract_meta_field(lines, "Endpoint")
        method = _extract_meta_field(lines, "Method")
        # Strix sometimes writes "N/A" for unknown fields — treat those as missing.
        for var_name in ("endpoint", "method", "cve"):
            if locals()[var_name] and locals()[var_name].strip().lower() in {"n/a", "none", "-"}:
                locals()[var_name] = None  # noqa: PLW0127  (assign to local for clarity)

        fingerprint = _compute_fingerprint(
            cwe=cwe, endpoint=endpoint, target=target, title=title,
        )

        sb.insert_finding(
            scan_id=scan_id,
            vuln_id=vuln_file.stem,
            title=title,
            severity=severity,
            payload={
                "description_md": text,
                "cvss": cvss,
                "cwe": cwe,
                "cve": cve,
                "target": target,
                "endpoint": endpoint,
                "method": method,
                "fingerprint": fingerprint,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("failed to ingest %s: %s", vuln_file, e)
