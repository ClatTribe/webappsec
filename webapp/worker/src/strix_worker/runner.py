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

# Event types from Strix's events.jsonl that we DON'T re-emit into scan_events.
# - finding.created: we ingest findings via the markdown files in
#   `vulnerabilities/` and call `worker_insert_finding` (which itself emits a
#   finding.created scan_event). Streaming the raw events.jsonl version too
#   would double up the timeline.
# - chat.message: every LLM round-trip's full content. Way too noisy for the
#   scan UI; the structured agent / tool events convey the same information.
_TAILER_SKIP_EVENT_TYPES = frozenset({"finding.created", "chat.message"})


# Strix renders its final stats panel through Rich. In a headless run it's
# still plain ASCII, but every value is humanised by `format_token_count`
# (see strix/interface/utils.py): >=1M -> "2.6M", >=1K -> "14.4K", else
# raw int. Cost is full precision: "$0.2392". The panel is reprinted as
# the live display refreshes, so we keep the running max across the
# whole stdout — values only grow, so max == final.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_TOKEN_RE = {
    "input": re.compile(r"Input Tokens\s+([\d.]+)\s*([MK])?", re.IGNORECASE),
    "output": re.compile(r"Output Tokens\s+([\d.]+)\s*([MK])?", re.IGNORECASE),
}
_COST_RE = re.compile(r"Cost[\s·]*\$([\d.]+)", re.IGNORECASE)
_AGENTS_RE = re.compile(r"\bAgents\b[\s·]*?(\d+)", re.IGNORECASE)


def _parse_humanized_count(num: str, suffix: str | None) -> int:
    try:
        value = float(num)
    except ValueError:
        return 0
    if suffix and suffix.upper() == "M":
        return int(value * 1_000_000)
    if suffix and suffix.upper() == "K":
        return int(value * 1_000)
    return int(value)


class StrixStats:
    """Accumulates token / cost / agent stats from Strix's stdout panel.

    Strix prints a live stats panel that is also reprinted at end of run
    (`build_final_stats_text` in strix/interface/utils.py). The numbers only
    grow, so taking a running max yields the final values regardless of how
    many times the panel is rendered.
    """

    def __init__(self) -> None:
        self.input_tokens: int = 0
        self.output_tokens: int = 0
        self.cost: float = 0.0
        self.agents_count: int = 0

    def feed(self, line: str) -> None:
        text = _ANSI_RE.sub("", line)
        if m := _TOKEN_RE["input"].search(text):
            self.input_tokens = max(
                self.input_tokens, _parse_humanized_count(m.group(1), m.group(2))
            )
        if m := _TOKEN_RE["output"].search(text):
            self.output_tokens = max(
                self.output_tokens, _parse_humanized_count(m.group(1), m.group(2))
            )
        if m := _COST_RE.search(text):
            try:
                self.cost = max(self.cost, float(m.group(1)))
            except ValueError:
                pass
        if m := _AGENTS_RE.search(text):
            try:
                self.agents_count = max(self.agents_count, int(m.group(1)))
            except ValueError:
                pass

    def as_finish_kwargs(self) -> dict[str, Any]:
        return {
            "total_input_tokens": self.input_tokens,
            "total_output_tokens": self.output_tokens,
            "total_cost": round(self.cost, 4),
            "agents_count": self.agents_count,
        }


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
    stats = StrixStats()

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

            workdir = _make_run_workdir(scan_id)
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                env={**os.environ, **env},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
            )

            tailer_stop = asyncio.Event()
            stdout_task = asyncio.create_task(
                _stream_logs(sb, scan_id, proc.stdout, "stdout", stats)
            )
            stderr_task = asyncio.create_task(_stream_logs(sb, scan_id, proc.stderr, "stderr"))
            events_task = asyncio.create_task(
                _stream_events_jsonl(sb, scan_id, workdir, tailer_stop)
            )

            exit_code = await proc.wait()
            tailer_stop.set()
            # Gather all readers before upload; the tailer must close events.jsonl
            # before _upload_run_artifacts reads it from disk.
            await asyncio.gather(stdout_task, stderr_task, events_task)

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
            **stats.as_finish_kwargs(),
        )
        logger.info(
            "scan %s done status=%s exit_code=%s tokens_in=%d tokens_out=%d cost=$%.4f agents=%d",
            scan_id,
            final_status,
            exit_code,
            stats.input_tokens,
            stats.output_tokens,
            stats.cost,
            stats.agents_count,
        )


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
    stats: StrixStats | None = None,
) -> None:
    """Stream stdout/stderr lines into scan_events as 'log' events.

    Strix's structured event stream lives in events.jsonl on disk, which we upload at the end.
    These log lines are a coarse live channel — fine for "show me what's happening now" UX.

    The optional `stats` accumulator parses Strix's stats panel out of stdout
    (token counts, cost, agent count). events.jsonl never carries these — the
    only place the totals reach the worker is the rendered panel.
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
                if stats is not None:
                    stats.feed(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("failed to emit log line: %s", e)


async def _stream_events_jsonl(
    sb: WorkerSupabase,
    scan_id: str,
    workdir: str,
    stop_event: asyncio.Event,
) -> None:
    """Tail Strix's events.jsonl as it's written, mirror events into scan_events.

    Strix emits a structured event stream (agent.created, tool.execution.started,
    run.configured, etc.) to `<cwd>/strix_runs/<run_name>/events.jsonl`. The file
    is uploaded as an artifact at scan exit, but until that point the only live
    signal in the UI is raw stdout. This coroutine bridges that gap: it
    discovers the run dir (we don't know the run_name ahead of time), then
    tails the file line by line and re-emits each event into `scan_events`.

    Cooperative shutdown: caller sets `stop_event` after `proc.wait()` returns.
    The tailer drains any remaining lines and closes the file before returning,
    so `_upload_run_artifacts` reads from a closed handle.
    """
    runs_root = Path(workdir) / "strix_runs"
    events_path: Path | None = None

    # Phase 1: discovery. Poll until events.jsonl appears or the run is over.
    # Bound the wait so a Strix that hangs before opening the file doesn't
    # pin this task forever.
    discovery_deadline = asyncio.get_event_loop().time() + 60.0
    while events_path is None:
        if runs_root.exists():
            for cand in runs_root.glob("*/events.jsonl"):
                events_path = cand
                break
        if events_path is not None:
            break
        if stop_event.is_set():
            # Final glob after the process exits.
            if runs_root.exists():
                for cand in runs_root.glob("*/events.jsonl"):
                    events_path = cand
                    break
            break
        if asyncio.get_event_loop().time() > discovery_deadline:
            logger.info("events.jsonl never appeared for scan %s within 60s", scan_id)
            return
        try:
            await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            return

    if events_path is None:
        return

    # Phase 2: tail. Read from byte 0, hold a buffer for partial trailing lines.
    buf = ""
    try:
        with events_path.open("r", encoding="utf-8", errors="replace") as fh:
            while True:
                chunk = fh.read()
                if chunk:
                    buf += chunk
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        _emit_jsonl_line(sb, scan_id, line)
                if stop_event.is_set():
                    # Drain remaining bytes (Strix writes the final events
                    # right before exit, so a final read is required).
                    chunk = fh.read()
                    if chunk:
                        buf += chunk
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        _emit_jsonl_line(sb, scan_id, line)
                    if buf.strip():
                        _emit_jsonl_line(sb, scan_id, buf)
                        buf = ""
                    return
                try:
                    await asyncio.sleep(0.25)
                except asyncio.CancelledError:
                    return
    except Exception:  # noqa: BLE001
        # A tailer crash must never short-circuit upload / finish_scan.
        logger.exception("events.jsonl tailer crashed for scan %s", scan_id)


def _emit_jsonl_line(sb: WorkerSupabase, scan_id: str, raw: str) -> None:
    """Parse one JSONL line, decide whether to forward it, and emit."""
    line = raw.strip()
    if not line:
        return
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        logger.debug("malformed events.jsonl line for scan %s: %r", scan_id, line[:200])
        return
    event_type = rec.get("event_type")
    if not event_type or event_type in _TAILER_SKIP_EVENT_TYPES:
        return
    try:
        sb.emit_event(scan_id, event_type, rec)
    except Exception as e:  # noqa: BLE001
        # One bad insert shouldn't halt the whole tailer.
        logger.warning("failed to emit %s for scan %s: %s", event_type, scan_id, e)


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
