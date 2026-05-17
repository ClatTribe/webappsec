"""Run a single scan: spawn Strix, tail its event stream, write events back to Supabase."""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import json
import logging
import os
import re
import shlex
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .code_context import parse_code_analysis_section
from .config import WorkerConfig
from .credentials import materialize_credentials
from .instruction import build_instruction
from .summary import summarize_scan
from .supabase_client import WorkerSupabase
from .triage import triage_scan_findings


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


# Heartbeat cadence (seconds). Worker writes to scans.last_heartbeat_at this
# often. Sweep tolerance lives in the listener as a multiple of this.
HEARTBEAT_INTERVAL_SEC = 60


# Engine PR #30 — preflight diagnostic markers. The engine writes a Rich
# diagnostic panel to stderr when preflight fails (DNS, HTTP reachability,
# etc.) before exiting with code 1. We pattern-match on the panel's stable
# text — `preflight` appears in both the title and per-target reasons. ANSI
# is stripped before the check (the panel is colour-coded via Rich).
#
# Conservative match: we require the literal substring "preflight" AND
# either "fail" or "did not" or "could not". A scan that genuinely
# discusses preflight in normal output (e.g. "preflight passed") won't
# trip this.
_PREFLIGHT_RE = re.compile(
    r"preflight[^\n]{0,120}?(fail|could not|did not|unreachable|unable to)",
    re.IGNORECASE,
)


class StderrTailBuffer:
    """Bounded ring buffer for the tail of stderr.

    The engine's preflight diagnostic panel is at most a few KB; a
    16 KiB tail captures it comfortably without holding the entire
    stderr in memory for long scans (where stderr can be megabytes
    of agent reasoning). Older bytes drop off the front as new ones
    arrive — by exit time the buffer holds only the final segment,
    which is exactly where the diagnostic landed.
    """

    _MAX_BYTES = 16 * 1024

    def __init__(self) -> None:
        self._chunks: list[str] = []
        self._size: int = 0

    def feed(self, text: str) -> None:
        if not text:
            return
        self._chunks.append(text)
        self._size += len(text)
        # Trim from the front while we're over budget. We keep one chunk
        # past the limit so we can still see partial markers that span
        # the boundary; close enough for grep purposes.
        while self._size > self._MAX_BYTES and len(self._chunks) > 1:
            dropped = self._chunks.pop(0)
            self._size -= len(dropped)

    def tail(self) -> str:
        return "\n".join(self._chunks)


def _looks_like_preflight_failure(stderr_tail: str) -> bool:
    """Pattern-match the engine's preflight diagnostic panel."""
    if not stderr_tail:
        return False
    plain = _ANSI_RE.sub("", stderr_tail)
    return bool(_PREFLIGHT_RE.search(plain))

# A registry of currently-running subprocesses, keyed by scan_id. The
# listener's scan_cancel handler reaches in here to send SIGTERM. We use a
# module-level dict instead of plumbing it through arguments so the cancel
# path doesn't need a back-channel into every run_scan invocation.
_RUNNING_PROCS: dict[str, asyncio.subprocess.Process] = {}


async def run_scan(scan_id: str, cfg: WorkerConfig, sb: WorkerSupabase) -> None:
    """Drive a single scan end to end. Always finalizes the scan row, even on error."""
    logger.info("picking up scan %s", scan_id)

    # Atomic claim. If another worker won the race, this returns None and we
    # bail — without ever calling start_scan or running Strix.
    try:
        claimed = sb.claim_scan(scan_id)
    except Exception:  # noqa: BLE001
        logger.exception("failed to claim scan %s", scan_id)
        return
    if not claimed:
        logger.info("scan %s already claimed by someone else; skipping", scan_id)
        return

    # claim_scan returns the bare scans row; we still need joined targets +
    # integrations for run-shaping. One extra round-trip but the SELECT is RLS-
    # cheap.
    try:
        scan = sb.fetch_scan(scan_id)
    except Exception:  # noqa: BLE001
        logger.exception("failed to fetch scan %s after claim", scan_id)
        # We claimed it, so we own marking it failed.
        sb.finish_scan(scan_id, "failed", error_message="failed to load scan after claim")
        return

    org_id = scan["org_id"]
    targets = scan.get("scan_targets") or []
    integrations = [si["integrations"] for si in (scan.get("scan_integrations") or [])]

    exit_code: int | None = None
    error_message: str | None = None
    final_status = "failed"
    stats = StrixStats()
    cancelled = False
    # Resolved inside the `with` block; defaulted here so the post-scan
    # triage call sees them as defined names even if _resolve_llm raised.
    llm_provider: str = ""
    llm_api_key: str = ""

    try:
        with materialize_credentials(sb, scan_id, integrations) as creds:
            llm_provider, llm_api_key = _resolve_llm(cfg, sb, scan)

            workdir = _make_run_workdir(scan_id)

            # FP feedback loop (§19.2 Tier 2). Write the org's accumulated
            # triage labels to <workdir>/feedback.jsonl so Strix can read
            # them via --feedback-from. Best-effort: if the RPC fails the
            # scan continues without the file (engine treats absence as
            # "no labels"). The org's auto-dismiss policy (default
            # `conservative`) flows in via STRIX_FP_AUTO_DISMISS env.
            feedback_path = _write_feedback_jsonl(sb, scan_id, org_id, workdir)
            fp_policy = _resolve_fp_policy(sb, org_id)

            # Threat-intel & recon API keys (§19.1 Tier 1 item 10, migration
            # 028). Each decrypted STRIX_* key gets forwarded into the
            # sandbox env unchanged. Tools fail-open per-tool when a key
            # is absent, so a missing key = silent feature degradation,
            # never a scan failure.
            org_strix_keys = sb.decrypt_org_secrets(scan_id)

            # §19.4 Tier 4 — compliance evidence pack (engine PR #129).
            # The engine writes an 8-file auditor bundle to
            # <workdir>/compliance_pack/<run_id>/. We pre-create the
            # parent directory so the engine doesn't fail on a missing
            # mkdir, then point strix at it via --compliance-pack.
            # After the run finishes we walk the directory and upload
            # everything to scan-artifacts storage.
            compliance_pack_path = str(Path(workdir) / "compliance_pack")
            Path(compliance_pack_path).mkdir(parents=True, exist_ok=True)

            # Tier A — HAR / Burp project imports (engine PR #141 /
            # migration 035). Pre-stage any uploaded files into
            # `<workdir>/imports/` so the agent can call
            # ingest_har_file / ingest_burp_file against them. Any
            # download failure is logged and the file is dropped from
            # the instruction text — partial pre-load beats failing the
            # whole scan.
            staged_imports = _download_imports(sb, scan_id, scan.get("imports"), workdir)

            # Phase A / migration 061 — per-scan auth credentials.
            # Falls back to the parent target's default when the scan
            # row has no override. Both may be None (no auth).
            auth_method, auth_plaintext = sb.decrypt_scan_auth(scan_id)

            env = _build_env(
                cfg, scan, creds.env, llm_provider, llm_api_key,
                feedback_path=feedback_path, fp_policy=fp_policy,
                org_strix_keys=org_strix_keys,
                auth_method=auth_method, auth_plaintext=auth_plaintext,
            )
            cmd = _build_cmd(
                cfg, scan, targets,
                feedback_path=feedback_path,
                compliance_pack_path=compliance_pack_path,
                staged_imports=staged_imports,
            )

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
                cwd=workdir,
            )
            _RUNNING_PROCS[scan_id] = proc

            tailer_stop = asyncio.Event()
            heartbeat_stop = asyncio.Event()
            # Tail of stderr — needed post-exit to detect engine PR #30
            # preflight failures (the diagnostic panel writes to stderr
            # right before exit-1).
            stderr_buf = StderrTailBuffer()
            stdout_task = asyncio.create_task(
                _stream_logs(sb, scan_id, proc.stdout, "stdout", stats)
            )
            stderr_task = asyncio.create_task(
                _stream_logs(sb, scan_id, proc.stderr, "stderr", stderr_buf=stderr_buf)
            )
            events_task = asyncio.create_task(
                _stream_events_jsonl(sb, scan_id, workdir, tailer_stop)
            )
            heartbeat_task = asyncio.create_task(
                _heartbeat_loop(sb, scan_id, heartbeat_stop)
            )

            exit_code = await proc.wait()
            tailer_stop.set()
            heartbeat_stop.set()
            # Gather all readers before upload; the tailer must close events.jsonl
            # before _upload_run_artifacts reads it from disk.
            await asyncio.gather(stdout_task, stderr_task, events_task, heartbeat_task)

        # Did the user (or some other actor) ask us to cancel this run while it
        # was in flight? If so, the row carries cancel_requested_at — even if
        # Strix happened to exit normally before SIGTERM landed, we still
        # honour the requested status.
        cancelled = _was_cancel_requested(sb, scan_id) or _exit_code_is_signal(exit_code)

        # Engine PR #30 — preflight defaults ON. Targets that fail
        # preflight exit 1 in ~5s with a diagnostic panel on stderr.
        # We pattern-match the panel out of the captured stderr tail
        # and flip scans.preflight_failed so the UI can render the
        # amber "preflight failed" banner. We only check on a real
        # failure exit (not on cancellation, not on success) so a
        # successful scan that happened to mention "preflight" in
        # passing can never trip this.
        if (
            not cancelled
            and exit_code is not None
            and exit_code not in (0, 2)
            and _looks_like_preflight_failure(stderr_buf.tail())
        ):
            try:
                sb.set_preflight_failed(scan_id)
            except Exception:  # noqa: BLE001
                # The flag is cosmetic; the failure surfaces via
                # exit_code + error_message regardless.
                logger.exception(
                    "scan %s: failed to set preflight_failed flag", scan_id
                )

        if cancelled:
            final_status = "cancelled"
            error_message = error_message or "scan cancelled"
        elif exit_code in (0, 2):
            # Strix's exit code convention: 0 = completed with no findings,
            # 2 = completed with findings. Anything else is a real failure.
            final_status = "completed"
        elif exit_code == 3:
            # Engine PR #113 — EXIT_BUDGET_EXCEEDED. The scan ran
            # cleanly until --max-cost or --max-input-tokens self-exit
            # tripped. We treat it as a failure so the dashboard
            # surfaces it distinctly from a clean completion, but the
            # error_message disambiguates "ran out of budget" from
            # "engine crashed" so the UI can render an appropriate
            # call-to-action ("raise budget" vs. "investigate logs").
            final_status = "failed"
            error_message = "scan stopped: budget exceeded"
        else:
            final_status = "failed"
            error_message = f"strix exited with code {exit_code}"

        # Upload run artifacts (events.jsonl, vuln md, final report) from the scan workdir.
        await _upload_run_artifacts(sb, scan_id, org_id)

        # Compliance evidence pack — sibling directory to strix_runs (engine
        # PR #129). Only upload when at least one file landed; older
        # engines that don't recognise --compliance-pack leave the dir
        # empty and we skip silently. Best-effort: failure to upload
        # never fails the scan — operators still get the rest of the
        # artifacts and can re-run if they need the pack.
        await _upload_compliance_pack(sb, scan_id, org_id)

        # Inline AI triage. Done *after* findings are written and *before*
        # finish_scan flips the row to completed so the user never sees a
        # window of unassessed findings on the dashboard. Failures here are
        # never fatal — a finding without an `ai_assessment` renders fine,
        # exactly as it did before this feature shipped.
        # `targets` is the per-scan target snapshot list joined by
        # fetch_scan; we pass it through so the triage step can build
        # source-code context for local_code targets (see code_context.py).
        if final_status == "completed":
            await _run_inline_triage(sb, scan_id, llm_provider, llm_api_key, targets)

    except Exception as e:  # noqa: BLE001
        logger.exception("scan %s failed", scan_id)
        error_message = str(e)
        final_status = "failed"

    finally:
        _RUNNING_PROCS.pop(scan_id, None)
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
        # Tier A — Slack notification (migration 037 + notifier.py).
        # Best-effort: any error inside is swallowed so the wrapper
        # never fails a scan over a flaky webhook. We pass the
        # in-scope `org_id` only when we got that far in run_scan;
        # if `claim_scan` lost the race we never load the org row,
        # in which case there's nothing to notify on anyway.
        try:
            if "org_id" in locals() and locals().get("org_id"):
                from .notifier import notify_scan_completion  # local import — keeps import-time graph clean
                notify_scan_completion(
                    sb,
                    scan_id=scan_id,
                    org_id=locals()["org_id"],
                    final_status=final_status,
                    error_message=error_message,
                    wrapper_origin=cfg.wrapper_origin,
                )
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: Slack notification dispatch crashed", scan_id)

        # Tier II #7 — GitHub PR sticky comment (migration 066).
        # If this scan was created by the /api/webhooks/github
        # receiver, the row carries `github_pull_request_number` and
        # the dispatch nudges the wrapper to (re)post the sticky
        # comment on the PR. No-op for non-PR-driven scans.
        # Best-effort: errors logged, never block scan finalisation.
        try:
            from .pr_comment_dispatch import dispatch_pr_comment  # local import
            dispatch_pr_comment(
                sb,
                scan_id=scan_id,
                wrapper_origin=cfg.wrapper_origin,
            )
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: PR comment dispatch crashed", scan_id)


def cancel_running_scan(scan_id: str) -> bool:
    """Send SIGTERM to the subprocess for `scan_id` if we have one running.

    Called by the listener when a scan_cancel notification arrives. Returns
    True if we actually had a process to signal.
    """
    proc = _RUNNING_PROCS.get(scan_id)
    if proc is None or proc.returncode is not None:
        return False
    try:
        proc.terminate()
        logger.info("SIGTERM sent to scan %s subprocess", scan_id)
        return True
    except ProcessLookupError:
        # Already gone.
        return False
    except Exception:  # noqa: BLE001
        logger.exception("failed to terminate scan %s subprocess", scan_id)
        return False


async def _heartbeat_loop(sb: WorkerSupabase, scan_id: str, stop: asyncio.Event) -> None:
    """Tick last_heartbeat_at every HEARTBEAT_INTERVAL_SEC while the scan runs.

    On stop, tries one final tick so the row reflects the moment the run ended
    — useful for the stale-scan sweep, which otherwise might race with the
    finish_scan write.
    """
    try:
        while not stop.is_set():
            try:
                sb.heartbeat_scan(scan_id)
            except Exception:  # noqa: BLE001
                # A heartbeat failure isn't fatal — the sweep will eventually
                # reap the row, but we shouldn't take the whole scan down.
                logger.warning("heartbeat for scan %s failed", scan_id, exc_info=True)
            try:
                await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_INTERVAL_SEC)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                return
    except asyncio.CancelledError:
        return


def _was_cancel_requested(sb: WorkerSupabase, scan_id: str) -> bool:
    """Check the current scan row for a cancel_requested_at timestamp."""
    try:
        result = (
            sb.client.table("scans")
            .select("cancel_requested_at")
            .eq("id", scan_id)
            .single()
            .execute()
        )
        return bool(result.data and result.data.get("cancel_requested_at"))
    except Exception:  # noqa: BLE001
        return False


def _exit_code_is_signal(exit_code: int | None) -> bool:
    """asyncio.create_subprocess_exec returns negative codes when the child was
    killed by a signal (POSIX convention: -SIGNUM). SIGTERM == 15."""
    return exit_code is not None and exit_code < 0


def _write_feedback_jsonl(
    sb: WorkerSupabase, scan_id: str, org_id: str, workdir: str
) -> str | None:
    """Write the org's accumulated triage labels to <workdir>/feedback.jsonl.

    The engine reads this on scan start (via --feedback-from) and uses it
    to auto-dismiss prior-FP fingerprints. See usage.md §4 for the schema.

    Best-effort: any failure logs and returns None; the engine treats
    absence as "no labels" and proceeds normally. The wrapper does NOT
    fail a scan because feedback writeback failed.

    Returns the absolute path to the file when written, or None on failure.
    """
    try:
        result = sb.client.rpc(
            "worker_feedback_jsonl_for_org", {"p_org_id": org_id}
        ).execute()
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: feedback RPC failed", scan_id)
        return None

    rows = result.data or []
    if not rows:
        # No labels yet — engine handles this fine via "no file present".
        return None

    path = Path(workdir) / "feedback.jsonl"
    try:
        with path.open("w", encoding="utf-8") as fh:
            for row in rows:
                # Each row is { "record": {...} }; the engine expects one
                # JSON object per line.
                rec = row.get("record") if isinstance(row, dict) else None
                if rec is None:
                    continue
                fh.write(json.dumps(rec, separators=(",", ":")))
                fh.write("\n")
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to write feedback.jsonl", scan_id)
        return None

    logger.info("scan %s: wrote %d feedback labels to %s", scan_id, len(rows), path)
    return str(path)


# Storage bucket the user uploads HAR/Burp files into. Defined here
# rather than imported from a shared constants module because the same
# string lives on the frontend; both sides change together when we ever
# rename it.
_USER_UPLOADS_BUCKET = "user-uploads"

# Closed enum mirroring the API zod schema. The SQL RPC's CHECK on the
# storage_path's org prefix is the security gate; this enum is the
# defence in depth against a future API drift that might pass through
# a `kind` the engine doesn't understand.
_ALLOWED_IMPORT_KINDS = frozenset({"har", "burp"})


def _download_imports(
    sb: WorkerSupabase,
    scan_id: str,
    imports_meta: Any,
    workdir: str,
) -> list[dict[str, str]]:
    """Stream each user-uploaded HAR/Burp file into <workdir>/imports/.

    Returns a list of {kind, container_path, filename} for each file
    that landed successfully. Failed downloads are logged and dropped —
    the agent will simply not be told about that file, and the rest of
    the scan continues. We never let an import-side error fail the
    whole scan.

    `imports_meta` is the JSONB blob persisted on `scans.imports` by
    the API route via the `create_scan_with_targets` RPC. Each entry
    has `{ kind, storage_path, filename, size_bytes }`. The SQL RPC
    already validated each storage_path's org prefix; here we re-validate
    the kind enum + filename shape (basename only, no `..` traversal).
    """
    if not isinstance(imports_meta, list) or len(imports_meta) == 0:
        return []

    imports_dir = Path(workdir) / "imports"
    imports_dir.mkdir(parents=True, exist_ok=True)

    staged: list[dict[str, str]] = []
    for entry in imports_meta:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        storage_path = entry.get("storage_path")
        filename = entry.get("filename")

        if (
            kind not in _ALLOWED_IMPORT_KINDS
            or not isinstance(storage_path, str)
            or not isinstance(filename, str)
            or not filename
        ):
            logger.warning(
                "scan %s: skipping malformed import entry %r", scan_id, entry
            )
            continue

        # Defence: keep filenames flat. The frontend should already
        # have stripped any path components, but the worker re-checks
        # before writing to disk so a forged metadata entry can't
        # write outside imports/.
        safe_name = Path(filename).name
        if not safe_name or safe_name in {".", ".."}:
            logger.warning(
                "scan %s: skipping import with unsafe filename %r", scan_id, filename
            )
            continue
        dest = imports_dir / safe_name

        try:
            content = sb.download_artifact(_USER_UPLOADS_BUCKET, storage_path)
        except Exception:  # noqa: BLE001
            logger.exception(
                "scan %s: failed to download import %s", scan_id, storage_path
            )
            continue

        if not isinstance(content, (bytes, bytearray)) or len(content) == 0:
            logger.warning(
                "scan %s: import %s came back empty/unexpected type", scan_id, storage_path
            )
            continue

        try:
            dest.write_bytes(bytes(content))
        except Exception:  # noqa: BLE001
            logger.exception(
                "scan %s: failed to write import %s to %s", scan_id, storage_path, dest
            )
            continue

        # `container_path` is workspace-relative — engine's
        # ingest_har_file / ingest_burp_file tools accept paths relative
        # to the agent's working directory, which is the same workdir
        # we set as the subprocess `cwd`.
        staged.append(
            {
                "kind": kind,
                "container_path": f"imports/{safe_name}",
                "filename": safe_name,
            }
        )
        logger.info(
            "scan %s: staged %s import %s (%d bytes)",
            scan_id, kind, safe_name, len(content),
        )

    return staged


def _imports_instruction_hint(
    staged_imports: list[dict[str, str]] | None,
) -> str | None:
    """Compose the natural-language hint telling the agent about
    pre-loaded traffic. Returns None when nothing was pre-loaded.

    The format is intentionally explicit — naming each tool by its
    engine name so the agent's planner can match without ambiguity.
    Sensitive-header redaction copy mirrors the wishlist §15.2 row 4
    upload-form notice so an auditor reviewing the instruction text
    sees the same statement.
    """
    if not staged_imports:
        return None

    lines: list[str] = [
        "Pre-loaded traffic is available in the workspace. "
        "Ingest each file before exploring on your own:"
    ]
    for entry in staged_imports:
        kind = entry["kind"]
        path = entry["container_path"]
        tool = "ingest_har_file" if kind == "har" else "ingest_burp_file"
        lines.append(f"- Call `{tool}('{path}')` (file: {entry['filename']}).")
    lines.append(
        "Sensitive header values (Authorization, Cookie, X-API-Key, etc.) "
        "are already redacted by the ingest tool — only header NAMES enter "
        "scan artifacts."
    )
    return "\n".join(lines)


def _resolve_fp_policy(sb: WorkerSupabase, org_id: str) -> str:
    """Read organizations.fp_auto_dismiss_policy. Defaults to 'conservative'
    on any read failure — matches the engine's own default."""
    try:
        result = (
            sb.client.table("organizations")
            .select("fp_auto_dismiss_policy")
            .eq("id", org_id)
            .single()
            .execute()
        )
        policy = (result.data or {}).get("fp_auto_dismiss_policy")
        if policy in ("conservative", "aggressive", "off"):
            return policy
    except Exception:  # noqa: BLE001
        logger.exception("org %s: failed to read fp_auto_dismiss_policy", org_id)
    return "conservative"


async def _run_inline_triage(
    sb: WorkerSupabase,
    scan_id: str,
    llm_provider: str,
    llm_api_key: str,
    scan_targets: list[dict[str, Any]] | None = None,
) -> None:
    """Triage every finding from this scan that doesn't already have an AI
    assessment. Emits `triage.started` / `triage.completed` events so the
    live event stream reflects the activity. Never raises — triage failures
    don't fail the scan, they just mean the finding renders without an AI
    verdict (which is fine, that's the pre-feature default).

    `scan_targets` is the per-scan target snapshot list (passed through
    from `fetch_scan`). When any target is `local_code`, triage gains a
    "Source code context" section built from the actual file contents
    around the cited line. See `code_context.gather_for_finding`.
    """
    if not (llm_provider and llm_api_key):
        # The scan ran on a worker-default model with no per-org key, or the
        # provider wasn't resolved. Skip silently — the user can still run
        # `assess_findings.py` manually after configuring a key.
        logger.info("scan %s: skipping inline triage (no LLM credentials)", scan_id)
        return

    try:
        sb.emit_event(scan_id, "triage.started", {"model": llm_provider})
    except Exception:  # noqa: BLE001
        # Event emission is cosmetic; never let it block the actual triage.
        logger.exception("scan %s: triage.started event emit failed", scan_id)

    try:
        stats = await triage_scan_findings(
            sb,
            scan_id,
            model=llm_provider,
            api_key=llm_api_key,
            scan_targets=scan_targets,
        )
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: inline triage pass crashed", scan_id)
        try:
            sb.emit_event(scan_id, "triage.completed", {"error": "crashed"})
        except Exception:  # noqa: BLE001
            pass
        return

    logger.info(
        "scan %s: triage done candidates=%d success=%d failed=%d skipped=%d",
        scan_id,
        stats.candidates,
        stats.success,
        stats.failed,
        stats.skipped,
    )
    try:
        sb.emit_event(
            scan_id,
            "triage.completed",
            {
                "candidates": stats.candidates,
                "success": stats.success,
                "failed": stats.failed,
                "skipped": stats.skipped,
            },
        )
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: triage.completed event emit failed", scan_id)

    # Plain-language scan summary. Runs after triage so the LLM has the
    # AI-assessed urgency breakdown to fold in. Best-effort: a missing
    # summary just hides the scan-page section, never fails the scan.
    try:
        await summarize_scan(sb, scan_id, model=llm_provider, api_key=llm_api_key)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: summary generation crashed", scan_id)


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


# Closed enum of recon/threat-intel keys the engine reads from the
# sandbox env. Mirrors migration 028's CHECK constraint and the
# settings UI's STRIX_KEYS list. Adding a new key requires a
# coordinated change in all three places.
_ALLOWED_ORG_STRIX_KEYS = frozenset({
    "STRIX_GITHUB_TOKEN",
    "STRIX_BING_KEY",
    "STRIX_SECURITYTRAILS_KEY",
    "STRIX_VIRUSTOTAL_KEY",
    "STRIX_VIEWDNS_KEY",
})


def _build_env(
    cfg: WorkerConfig,
    scan: dict[str, Any],
    cred_env: dict[str, str],
    llm_provider: str,
    llm_api_key: str,
    *,
    feedback_path: str | None = None,
    fp_policy: str | None = None,
    org_strix_keys: dict[str, str] | None = None,
    auth_method: str | None = None,
    auth_plaintext: str | None = None,
) -> dict[str, str]:
    env = {
        "STRIX_LLM": llm_provider,
        "LLM_API_KEY": llm_api_key,
        # Belt-and-braces: litellm's per-provider adapters look for the
        # provider-specific env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
        # GEMINI_API_KEY) directly when the strix-level LLM_API_KEY isn't
        # threaded through the call path. The strix wrapper-integration
        # doc claimed "strix does not read ANTHROPIC_API_KEY" — technically
        # true at strix's Config layer, but practically false at the
        # actual API-call layer, where missing keys produced:
        #     litellm.AuthenticationError: Missing Anthropic API Key
        # Source: ClatTribe/strix PR #226. We set all three to the same
        # value rather than parsing the provider prefix — bulletproof and
        # only costs three extra env-var assignments.
        "ANTHROPIC_API_KEY": llm_api_key,
        "OPENAI_API_KEY": llm_api_key,
        "GEMINI_API_KEY": llm_api_key,
        "STRIX_IMAGE": cfg.strix_image,
        # Disable cli-config persistence — we never want a server worker to write ~/.strix/cli-config.json
        "STRIX_PERSIST_CONFIG": "false",
        # Default to the single-lead architecture (engine roadmap §8.5 Phase 3).
        # Engine accepts the literal `single-lead` (case-insensitive); any
        # other value, including unset, falls back to the legacy
        # parent-spawns-N pattern. We default to single-lead so wrapper
        # behaviour is deterministic across engine version bumps, and so
        # specialist-dispatch + cost-cap accounting match what the engine's
        # roadmap PR series targets. An operator who wants the legacy
        # behaviour can set `STRIX_AGENT_ARCHITECTURE=legacy` (or any non-
        # `single-lead` value) in the worker's own environment — the
        # pass-through below picks that up.
        "STRIX_AGENT_ARCHITECTURE": os.environ.get(
            "STRIX_AGENT_ARCHITECTURE", "single-lead"
        ),
        # Run logs directory; we'll harvest after exit.
        "PYTHONUNBUFFERED": "1",
    }
    # Engine PR #30 — passive recon mode (domain targets only). The
    # wrapper opts in via the new-scan form's "Surface-map only" toggle;
    # surface as STRIX_DNS_ONLY=1 (engine accepts both env and --dns-only
    # flag). When false we omit the var entirely so older Strix versions
    # without --dns-only keep working unchanged.
    if scan.get("dns_only"):
        env["STRIX_DNS_ONLY"] = "1"
    # Wishlist §18.7 / engine PR #278 — MOAK live-probe consent.
    # When the parent target's config has allow_live_probe=true the
    # wrapper forwards STRIX_MOAK_LIVE_PROBE=1, gating the engine's
    # LiveProbe stage. Default off; the engine's safety policy
    # (PR #278) further restricts which findings are eligible.
    parent_cfg = (scan.get("targets") or {}).get("config") or {}
    if isinstance(parent_cfg, dict) and parent_cfg.get("allow_live_probe") is True:
        env["STRIX_MOAK_LIVE_PROBE"] = "1"
    # FP feedback loop (engine PR #142). The wrapper writes the org's
    # accumulated labels to feedback.jsonl; engine reads via --feedback-from
    # AND/OR STRIX_FEEDBACK_FROM. We forward both for belt-and-braces.
    if feedback_path:
        env["STRIX_FEEDBACK_FROM"] = feedback_path
    if fp_policy:
        env["STRIX_FP_AUTO_DISMISS"] = fp_policy
    # §19.1 Tier 1 item 10 — per-org threat-intel & recon API keys.
    # The decrypt RPC already filters to the migration's CHECK enum,
    # but we re-check here so a future RPC drift can't smuggle an
    # arbitrary env var into the sandbox. Empty values are dropped.
    if org_strix_keys:
        for key, value in org_strix_keys.items():
            if key in _ALLOWED_ORG_STRIX_KEYS and isinstance(value, str) and value:
                env[key] = value

    # Phase A / migration 061 — scan auth credentials. Engine env vars
    # (per wrapper-integration.md §1):
    #   STRIX_AUTH_BEARER / STRIX_AUTH_COOKIE / STRIX_AUTH_BASIC /
    #   STRIX_HEADERS (newline-joined). We use env rather than CLI flag
    #   for these because the engine treats both as identical and env
    #   keeps the value out of argv / process listings.
    #
    # `header` is the multi-value case — plaintext is JSON
    # {"headers": [...]} (see migration 061 docstring). We join with
    # newlines to match the engine's STRIX_HEADERS expectation.
    # `login_creds` rides the existing instruction text path — engine
    # accepts the literal as part of `--instruction` per PR #156.
    if auth_method and auth_plaintext:
        if auth_method == "bearer":
            env["STRIX_AUTH_BEARER"] = auth_plaintext
        elif auth_method == "cookie":
            env["STRIX_AUTH_COOKIE"] = auth_plaintext
        elif auth_method == "basic":
            env["STRIX_AUTH_BASIC"] = auth_plaintext
        elif auth_method == "header":
            try:
                parsed = json.loads(auth_plaintext)
                headers = parsed.get("headers") if isinstance(parsed, dict) else None
                if isinstance(headers, list):
                    cleaned = [h for h in headers if isinstance(h, str) and h.strip()]
                    if cleaned:
                        env["STRIX_HEADERS"] = "\n".join(cleaned)
            except (json.JSONDecodeError, AttributeError):
                logger.warning("scan %s: malformed header auth plaintext", scan.get("id"))
        elif auth_method == "login_creds":
            # Engine PR #156 — tenant-supplied login credentials for the
            # `scan_auth_flow` specialist. Plaintext is a JSON list of
            # {username, password} objects; engine reads STRIX_LOGIN_CREDS
            # in that shape directly. Wrapper validates JSON-ness before
            # forwarding so a malformed string can't break the agent loop.
            try:
                parsed = json.loads(auth_plaintext)
                if isinstance(parsed, list) and parsed:
                    env["STRIX_LOGIN_CREDS"] = json.dumps(parsed)
            except json.JSONDecodeError:
                logger.warning("scan %s: malformed login_creds plaintext", scan.get("id"))

    # Phase A — outbound rate limit. Engine reads STRIX_RATE_LIMIT or
    # --rate-limit; we forward via env so the value isn't part of argv.
    rate_limit_qps = scan.get("rate_limit_qps")
    if isinstance(rate_limit_qps, int) and rate_limit_qps > 0:
        env["STRIX_RATE_LIMIT"] = str(rate_limit_qps)

    # Phase A — exclude paths. Newline-joined; engine accepts
    # STRIX_EXCLUDE_PATHS or repeated --exclude-path. We use env to
    # keep argv compact when there are many.
    exclude_paths = scan.get("exclude_paths")
    if isinstance(exclude_paths, list) and exclude_paths:
        cleaned = [p for p in exclude_paths if isinstance(p, str) and p.strip()]
        if cleaned:
            env["STRIX_EXCLUDE_PATHS"] = "\n".join(cleaned)

    # Phase A — seed URLs (web_application targets). Newline-joined
    # for STRIX_SEED_URLS; engine accepts the env or repeated --seed-url.
    seed_urls = scan.get("seed_urls")
    if isinstance(seed_urls, list) and seed_urls:
        cleaned = [u for u in seed_urls if isinstance(u, str) and u.strip()]
        if cleaned:
            env["STRIX_SEED_URLS"] = "\n".join(cleaned)
    env.update(cred_env)
    return env


def _build_cmd(
    cfg: WorkerConfig,
    scan: dict[str, Any],
    targets: list[dict[str, Any]],
    *,
    feedback_path: str | None = None,
    compliance_pack_path: str | None = None,
    staged_imports: list[dict[str, str]] | None = None,
) -> list[str]:
    cmd = [cfg.strix_bin, "-n", "-m", scan["scan_mode"]]

    if scan.get("scope_mode") and scan["scope_mode"] != "auto":
        cmd += ["--scope-mode", scan["scope_mode"]]

    # Engine PR #142 — feedback.jsonl path. CLI flag takes precedence over
    # STRIX_FEEDBACK_FROM env. We forward both because either alone has
    # bitten us in the past.
    if feedback_path:
        cmd += ["--feedback-from", feedback_path]
    if scan.get("diff_base"):
        cmd += ["--diff-base", scan["diff_base"]]
    # Engine PR #117 / migration 033 — repository branch picker. The
    # form lets the operator type a ref (branch / tag / SHA) for
    # repository-typed targets; we forward as `--branch <ref>` so the
    # engine checks out the right tree before scanning. Trim defensively
    # in case a stray space made it through the API.
    if scan.get("branch"):
        branch = str(scan["branch"]).strip()
        if branch:
            cmd += ["--branch", branch]
    # Engine PR #113 / migration 034 — cost-cap self-exit gates. The
    # engine watches LLM cost + token usage and exits with code 3
    # (EXIT_BUDGET_EXCEEDED) plus a `run.terminated{reason: budget_
    # exceeded}` event when either threshold trips. The form / RPC
    # both reject non-positive values, but we re-validate here so a
    # rogue API caller can't inject a 0 (which the engine would treat
    # as "no usage allowed" and trip immediately).
    max_cost = scan.get("max_cost")
    if isinstance(max_cost, (int, float)) and max_cost > 0:
        cmd += ["--max-cost", str(max_cost)]
    max_input_tokens = scan.get("max_input_tokens")
    if isinstance(max_input_tokens, int) and max_input_tokens > 0:
        cmd += ["--max-input-tokens", str(max_input_tokens)]

    # Engine PR #129 — auditor-grade evidence bundle. The engine writes
    # an 8-file pack to `<path>/<run_id>/` containing manifest, control
    # attestation, coverage attestation, findings.csv, events excerpt +
    # signature, run_meta.json, and a SHA256SUMS over them all. The
    # wrapper uploads the directory after the run and serves it as a
    # zip download. We always pass the flag — the entire wrapper assumes
    # the ClatTribe/strix fork (which carries #129).
    if compliance_pack_path:
        cmd += ["--compliance-pack", compliance_pack_path]

    # Phase A — direct GRC exports. The engine writes
    # `grc_export_<platform>.json` next to vulnerabilities.json for
    # each --export-format the user picked. Wrapper API + frontend
    # restrict to the engine's enum
    # {vanta, drata, hyperproof, secureframe, servicenow, generic}.
    export_formats = scan.get("export_formats")
    if isinstance(export_formats, list):
        for fmt in export_formats:
            if isinstance(fmt, str) and fmt.strip():
                cmd += ["--export-format", fmt.strip()]

    # Engine PR #271 / PR #274 — `<type>:<value>` prefix on `--target`.
    # We use the prefix for two types whose values the engine's URL-
    # shape inference cannot disambiguate:
    #   - `api:` (PR #267-#271) — a JSON API at `https://api.example.com`
    #      looks identical to a web app at `https://example.com`, but the
    #      two should run different tool catalogs (the api catalog drops
    #      browser / DOM / scan_xss / bfs_crawl).
    #   - `container_image:` (PR #274) — image refs like `nginx:1.25` are
    #      syntactically ambiguous with `host:port` strings. The engine's
    #      `_infer_container_image_value` validator REQUIRES the prefix
    #      and rejects URL-shaped values; without the prefix the engine
    #      would never route to scan_container_image.
    #
    # All other target types travel as bare `--target <value>` so older
    # Strix versions (pre-PR-#271) keep working unchanged AND so we
    # don't trigger the engine's strict-match check — if the wrapper
    # DB classified a github URL as `web_application` (operator error)
    # and we passed `web_application:https://github.com/...`, the
    # engine would reject it (the URL parses as `repository`). Letting
    # those types fall through to the bare form keeps the engine's
    # own inference as the safety net.
    # `cloud_account` added 2026-05-17 for engine PRs #290/#291. Same
    # contract as container_image — the value carries `<provider>/<id>`
    # (e.g. `aws/123456789012`) and the engine routes to the right
    # CSPM specialist (boto3 path for AWS, Prowler for everything else).
    # AWS creds are already plumbed via materialize_credentials → env;
    # boto3's standard chain inside the engine picks them up.
    _PREFIXED_TYPES = ("api", "container_image", "cloud_account")
    for target in targets:
        t_value = target["value"]
        t_type = target.get("type")
        if t_type in _PREFIXED_TYPES:
            cmd += ["-t", f"{t_type}:{t_value}"]
        else:
            cmd += ["-t", t_value]

    # Engine PRs #267 + #271 — when the parent target is `api`-typed
    # and the tenant supplied an OpenAPI / Swagger spec URL in its
    # config, forward it as `--openapi <url>`. The engine otherwise
    # probes 11 standard publishing paths automatically
    # (`/openapi.json`, `/swagger.json`, `/v3/api-docs`, etc.) — this
    # just short-circuits discovery when the spec lives elsewhere.
    #
    # The parent target config lives at `scan["targets"]["config"]` via
    # the supabase_client.fetch_scan() FK join; the per-scan
    # scan_targets rows (the `targets` argument) don't carry config.
    # We honour spec_url only when the parent target type is `api` to
    # keep the contract clean — a web_application target with a stray
    # spec_url in its config is silently ignored.
    parent_target = scan.get("targets") or {}
    if parent_target.get("type") == "api":
        spec_url = (parent_target.get("config") or {}).get("spec_url")
        if isinstance(spec_url, str) and spec_url.strip():
            cmd += ["--openapi", spec_url.strip()]

    # Combine the user's free-form instruction with augmented text derived
    # from `targets.config` (per-target-type configuration). See
    # `instruction.build_instruction` for the contract.
    instr = build_instruction(scan)
    # Tier A — HAR / Burp pre-load hint (engine PR #141 / migration 035).
    # We append a directive listing each staged import so the agent
    # knows to call ingest_har_file / ingest_burp_file against the
    # right paths before its own recon. Hint is omitted entirely when
    # nothing was pre-loaded.
    imports_hint = _imports_instruction_hint(staged_imports)
    if imports_hint:
        instr = f"{instr}\n\n{imports_hint}" if instr else imports_hint
    if instr:
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
    stderr_buf: StderrTailBuffer | None = None,
) -> None:
    """Stream stdout/stderr lines into scan_events as 'log' events.

    Strix's structured event stream lives in events.jsonl on disk, which we upload at the end.
    These log lines are a coarse live channel — fine for "show me what's happening now" UX.

    The optional `stats` accumulator parses Strix's stats panel out of stdout
    (token counts, cost, agent count). events.jsonl never carries these — the
    only place the totals reach the worker is the rendered panel.

    The optional `stderr_buf` accumulates the tail of the stream for post-exit
    pattern-matching (engine PR #30 preflight diagnostic). Caller wires this
    only on the stderr task so stdout text doesn't dilute the buffer.
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
                if stderr_buf is not None:
                    stderr_buf.feed(text)
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


# Mimetype hints for the compliance-pack uploader. Auditors expect text
# previews to render inline when they hit the per-file signed URL, so we
# surface a few common shapes by extension. Anything else falls back to
# the storage-default `text/plain; charset=utf-8`.
_PACK_CONTENT_TYPES = {
    ".json":   "application/json",
    ".csv":    "text/csv",
    ".md":     "text/markdown",
    ".jsonl":  "application/x-ndjson",
    ".txt":    "text/plain; charset=utf-8",
    ".sha256": "text/plain; charset=utf-8",
    ".sig":    "application/octet-stream",
}


def _content_type_for(path: Path) -> str:
    """Return a sensible content-type for a compliance-pack file."""
    return _PACK_CONTENT_TYPES.get(path.suffix.lower(), "text/plain; charset=utf-8")


def _compliance_pack_root(scan_id: str) -> Path:
    """Where the worker tells strix to write the auditor bundle.

    Sibling to `strix_runs/` under the per-scan workdir so a single
    rmtree(workdir) cleans both up. Tests override the path directly
    by passing a different root to `_upload_compliance_pack`.
    """
    return Path(f"/tmp/strix-runs/{scan_id}/compliance_pack")


async def _upload_compliance_pack(
    sb: WorkerSupabase,
    scan_id: str,
    org_id: str,
    pack_root: Path | None = None,
) -> None:
    """Upload <workdir>/compliance_pack/ to scan-artifacts at
    `<org_id>/<scan_id>/compliance_pack/...` (engine PR #129).

    The engine writes an 8-file bundle plus a SHA256SUMS into
    `<compliance_pack_path>/<run_id>/`. We mirror the directory tree
    verbatim — the wrapper's API route lists the prefix and zips on
    demand. Only flips `scans.compliance_pack_uploaded` when at least
    one file landed; an empty directory (older engines without #129)
    leaves the flag false and the UI hides the download button.

    Per-file failures are logged and the loop continues — partial
    uploads are still useful for auditors. A whole-step failure is
    swallowed so a misconfigured storage bucket can't take down the
    scan finalisation.

    After uploading: scans the pack for `compliance_evidence.json`
    (engine PR #219 §4b) and calls the wrapper's ingest RPC so the
    chat handler + trust page can answer "how ready am I for SOC 2?"
    with real data. Ingest failures don't fail the upload.
    """
    pack_root = pack_root or _compliance_pack_root(scan_id)
    if not pack_root.exists():
        logger.info("no compliance_pack dir for scan %s; skipping upload", scan_id)
        return

    uploaded_any = False
    prefix = f"{org_id}/{scan_id}/compliance_pack"
    try:
        for path in pack_root.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(pack_root)
            key = f"{prefix}/{rel}"
            try:
                contents = path.read_bytes()
                sb.upload_artifact(
                    SCAN_ARTIFACTS_BUCKET, key, contents, _content_type_for(path)
                )
                uploaded_any = True
            except Exception as e:  # noqa: BLE001
                logger.warning("compliance pack upload of %s failed: %s", key, e)
    except Exception:  # noqa: BLE001
        logger.exception("compliance pack walk failed for scan %s", scan_id)

    if uploaded_any:
        try:
            sb.set_compliance_pack_uploaded(scan_id)
        except Exception:  # noqa: BLE001
            # Cosmetic flag — we already have the files; the UI will just
            # not surface the download button. Better than failing the
            # scan finalisation over a single missing mutation.
            logger.exception(
                "scan %s: failed to flip compliance_pack_uploaded", scan_id
            )

    # Compliance-evidence ingest. Runs whether or not the storage upload
    # succeeded — the structured ingest is independent of the auditor-pack
    # zip and useful on its own (chat + trust page query the DB, not S3).
    try:
        _ingest_compliance_evidence_from_pack(sb, scan_id, pack_root)
    except Exception:  # noqa: BLE001
        logger.exception(
            "scan %s: compliance_evidence.json ingest failed", scan_id
        )


def _ingest_compliance_evidence_from_pack(
    sb: WorkerSupabase,
    scan_id: str,
    pack_root: Path,
) -> None:
    """Find + parse + ingest compliance_evidence.json (engine PR #219 §4b).

    The engine writes per-control verdicts into
    `<compliance_pack>/<run_id>/compliance_evidence.json`. We rglob
    because the run_id directory layer is part of the engine's layout
    and we don't want to hardcode it. First match wins — multi-run
    packs are not expected.

    Older engines that don't emit this file leave it absent and we
    silently skip — the chat handler answers "no evidence yet" until
    the engine version that emits it lands in the operator's sandbox.
    """
    matches = list(pack_root.rglob("compliance_evidence.json"))
    if not matches:
        logger.info(
            "scan %s: no compliance_evidence.json in pack; skipping ingest",
            scan_id,
        )
        return

    evidence_path = matches[0]
    try:
        with evidence_path.open("r", encoding="utf-8") as f:
            evidence = json.load(f)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "scan %s: compliance_evidence.json at %s unreadable: %s",
            scan_id, evidence_path, e,
        )
        return

    if not isinstance(evidence, dict) or not evidence:
        logger.info(
            "scan %s: compliance_evidence.json is empty / non-dict; nothing to ingest",
            scan_id,
        )
        return

    try:
        count = sb.ingest_compliance_evidence(scan_id, evidence)
        logger.info(
            "scan %s: ingested %d compliance controls from %s",
            scan_id, count, evidence_path,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "scan %s: ingest RPC failed: %s",
            scan_id, e,
        )


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

        # Engine run_meta.json — vendor_risk, mfa_attestation,
        # compliance_posture, etc. (migration 031 / §19.4 Tier 4). We
        # persist the whole file as JSONB so adding a new top-level
        # signal is a UI change, not a schema change. Per
        # Architecture.md §1.1 — the engine writes; the wrapper stores.
        _persist_run_meta(sb, scan_id, run_dir)

        # Engine coverage.json — required-checks list + actual-ran
        # checks + gap list (migration 039). Critical UX bridge: a
        # 0-finding scan is ambiguous between "site is clean" and
        # "agent gave up early"; coverage tells you which. The UI's
        # amber "coverage incomplete" banner keys off this column.
        _persist_coverage(sb, scan_id, run_dir)

        # Engine kg.json — typed knowledge graph
        # (strix PRs #240/#265/#266 / migration 058). Powers the
        # "Discovered" panel on scan detail: assets, surfaces,
        # secrets, credentials, dependencies, threat-intel
        # observations, synthesised exploits + the relationships
        # between them. Best-effort; older engines without §3 typed
        # KG leave the file absent and we silently skip.
        try:
            _ingest_kg_from_run_dir(sb, scan_id, scan["org_id"], run_dir)
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: kg.json ingest failed", scan_id)

        # Engine patches.jsonl — Patcher specialist proposals
        # (strix PRs #243/#250 / migration 058). One row per patch
        # the engine proposed for a verified finding; we attach the
        # diff + status to the matching findings row. Best-effort;
        # older engines without the Patcher leave the file absent.
        try:
            _ingest_patches_from_run_dir(sb, scan_id, run_dir)
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: patches.jsonl ingest failed", scan_id)

        # Phase A #5 / migration 062 — SARIF upload to GitHub Code
        # Scanning. Only fires when (a) the parent target is a
        # repository, (b) it has integration_id set to a GitHub OAuth
        # integration, and (c) the engine wrote *.sarif files in the
        # run dir. Anything else (no sarif, non-github host, no
        # integration, API failure) is a silent skip — the wrapper UI
        # gates the "View in Code Scanning" link on the row's URL.
        try:
            _upload_sarif_to_code_scanning(sb, scan_id, scan, run_dir)
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: SARIF Code Scanning upload failed", scan_id)

        # CycloneDX SBOM (engine PR #131 / §19.4 Tier 4 row 3,
        # migration 032). The file itself was already uploaded by the
        # rglob("*") loop above; we only need to flip the boolean so
        # the UI knows the SBOM CTAs are safe to render. Older engines
        # without #131 leave the flag false.
        if (run_dir / "sbom.cdx.json").exists():
            try:
                sb.set_sbom_uploaded(scan_id)
            except Exception:  # noqa: BLE001
                # Cosmetic flag — file's already in storage; the UI
                # just won't surface the CTAs. Better than failing
                # finalisation over a single missing mutation.
                logger.exception(
                    "scan %s: failed to flip sbom_uploaded flag", scan_id
                )

        # Per-finding reasoning trail (engine PR #142 / §15.1 Tier 2). The
        # engine writes one trajectory record per finding to
        # `<run_dir>/trajectory.jsonl`. We load the whole file once, key by
        # finding_id, and attach the matching record to each finding's
        # payload during ingestion. Absence is fine (older engines, scans
        # without findings) — the column just stays null.
        trajectories = _load_trajectories(run_dir)

        # Ingest findings. Prefer the engine's structured vulnerabilities.json
        # (richer schema — confidence, reasoning_trace, counter_proof, category,
        # priority_label, etc.) and fall back to per-vuln markdown for older
        # Strix versions that don't write the JSON. Per Architecture.md §1.1
        # doctrine: the engine's structured signal is the source of truth;
        # markdown parsing is the fallback.
        vulns_json = run_dir / "vulnerabilities.json"
        if vulns_json.exists():
            _ingest_findings_from_json(sb, scan_id, vulns_json, trajectories)
        else:
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


def _persist_coverage(sb: WorkerSupabase, scan_id: str, run_dir: Path) -> None:
    """Read <run_dir>/coverage.json and stash on `scans.coverage`
    (migration 039 / Tier-A trust-gap fix).

    Best-effort: missing file / parse error / non-object top level all
    log + skip. The amber "coverage incomplete" banner simply doesn't
    render — but the existing finding-counts UX is unchanged.

    A clean coverage report (`status="complete"` / `coverage_percent`
    >= 100) lets the wrapper's vendor-risk + summary copy stand
    unqualified. An incomplete one *replaces* the muted summary with
    an explicit "agent didn't cover X / Y / Z" banner so customers
    can't be led to assume thoroughness from a 0-finding scan.
    """
    path = run_dir / "coverage.json"
    if not path.exists():
        logger.info("scan %s: no coverage.json — skipping persist", scan_id)
        return
    try:
        data = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to parse coverage.json", scan_id)
        return
    if not isinstance(data, dict):
        logger.warning("scan %s: coverage.json is not a JSON object", scan_id)
        return
    try:
        sb.set_coverage(scan_id, data)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to persist coverage", scan_id)


def _persist_run_meta(sb: WorkerSupabase, scan_id: str, run_dir: Path) -> None:
    """Read <run_dir>/run_meta.json and stash the whole blob on the scan
    row (migration 031). Best-effort: a missing file or parse error is
    logged and skipped — the UI hides the corresponding hero widgets
    rather than render bogus data.

    This is intentionally a single JSONB write rather than per-signal
    columns. The engine adds top-level keys to run_meta over time
    (vendor_risk → mfa_attestation → compliance_posture → ...); a
    typed-column-per-signal model would force a migration on every
    additive engine change.

    The blob *can* be sizeable in long-target scans, but real-world
    samples are well under 100 KiB; well within Postgres JSONB sweet
    spot. If we ever see >1 MiB run_metas we can switch to selective
    extraction here.
    """
    path = run_dir / "run_meta.json"
    if not path.exists():
        logger.info("scan %s: no run_meta.json — skipping persist", scan_id)
        return
    try:
        data = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to parse run_meta.json", scan_id)
        return
    if not isinstance(data, dict):
        logger.warning("scan %s: run_meta.json is not a JSON object", scan_id)
        return
    try:
        sb.set_run_meta(scan_id, data)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to persist run_meta", scan_id)


_KG_NODE_TYPES = frozenset({
    "Surface", "Asset", "Vuln", "Credential", "Secret",
    "Dependency", "Role", "ThreatIntel", "Exploit",
})
_KG_EDGE_TYPES = frozenset({
    "AFFECTS", "REACHABLE_FROM", "LEAKS", "GRANTS_ACCESS_TO",
    "CHAINS_TO", "RUNS_ON", "USES", "OBSERVED",
    "PIVOTED_FROM", "EXPLOITS",
})


def _ingest_kg_from_run_dir(
    sb: WorkerSupabase, scan_id: str, org_id: str, run_dir: Path
) -> None:
    """Read <run_dir>/kg.json (strix PRs #240/#265/#266) and bulk-insert
    its nodes + edges into kg_nodes / kg_edges (migration 058).

    The engine serialises a process-global singleton KG to disk at scan
    end. Schema (from strix/agents/knowledge_graph.py):

      { "version": 1,
        "nodes": [ { "id": "N-001", "type": "Surface", "props": {...},
                     "created_at": float, "updated_at": float } ],
        "edges": [ { "id": "E-001", "type": "AFFECTS",
                     "source": "N-001", "target": "N-002",
                     "props": {...}, "created_at": float } ] }

    Best-effort across the board: missing file, parse error, unknown
    node/edge type — log and skip. An unknown type is the most likely
    "engine added a new node kind faster than the wrapper bumped its
    CHECK constraint" case; preferable to surface a partial KG than
    fail the whole ingest.
    """
    path = run_dir / "kg.json"
    if not path.exists():
        logger.info("scan %s: no kg.json — skipping KG ingest", scan_id)
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to parse kg.json", scan_id)
        return
    if not isinstance(data, dict):
        logger.warning("scan %s: kg.json is not a JSON object", scan_id)
        return

    raw_nodes = data.get("nodes") if isinstance(data.get("nodes"), list) else []
    raw_edges = data.get("edges") if isinstance(data.get("edges"), list) else []

    node_rows: list[dict[str, Any]] = []
    skipped_unknown_types: set[str] = set()
    for n in raw_nodes:
        if not isinstance(n, dict):
            continue
        node_id = n.get("id")
        node_type = n.get("type")
        if not isinstance(node_id, str) or not isinstance(node_type, str):
            continue
        if node_type not in _KG_NODE_TYPES:
            # Skip but track so we can flag engine drift in one log line.
            skipped_unknown_types.add(node_type)
            continue
        node_rows.append({
            "org_id": org_id,
            "scan_id": scan_id,
            "node_id": node_id,
            "node_type": node_type,
            "props": n.get("props") or {},
        })

    edge_rows: list[dict[str, Any]] = []
    skipped_unknown_edge_types: set[str] = set()
    for e in raw_edges:
        if not isinstance(e, dict):
            continue
        edge_id = e.get("id")
        edge_type = e.get("type")
        source = e.get("source")
        target = e.get("target")
        if not all(isinstance(v, str) for v in (edge_id, edge_type, source, target)):
            continue
        if edge_type not in _KG_EDGE_TYPES:
            skipped_unknown_edge_types.add(edge_type)
            continue
        edge_rows.append({
            "org_id": org_id,
            "scan_id": scan_id,
            "edge_id": edge_id,
            "edge_type": edge_type,
            "source_node_id": source,
            "target_node_id": target,
            "props": e.get("props") or {},
        })

    if skipped_unknown_types:
        logger.warning(
            "scan %s: KG ingest skipped %d nodes with unknown types: %s "
            "— engine likely added a new NodeType ahead of the wrapper's "
            "CHECK constraint; add the type to migration 058 to surface "
            "them in the UI.",
            scan_id, sum(1 for n in raw_nodes if isinstance(n, dict) and n.get("type") in skipped_unknown_types),
            sorted(skipped_unknown_types),
        )
    if skipped_unknown_edge_types:
        logger.warning(
            "scan %s: KG ingest skipped edges with unknown types: %s",
            scan_id, sorted(skipped_unknown_edge_types),
        )

    try:
        n_nodes = sb.insert_kg_nodes(node_rows) if node_rows else 0
        n_edges = sb.insert_kg_edges(edge_rows) if edge_rows else 0
        logger.info(
            "scan %s: ingested KG — %d nodes / %d edges",
            scan_id, n_nodes, n_edges,
        )
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: KG bulk-insert failed", scan_id)


def _ingest_patches_from_run_dir(
    sb: WorkerSupabase, scan_id: str, run_dir: Path
) -> None:
    """Read <run_dir>/patches.jsonl (strix PRs #243/#250) and update the
    matching findings rows with patch_* columns (migration 058).

    One JSON object per line; schema mirrors PatchProposal in
    strix/agents/patcher.py:

      { "patch_id":  "PATCH-abc123",
        "finding_id": "<engine finding id>",
        "diff":       "<unified diff>",
        "commit_message": "<conventional commit summary>",
        "diff_hash":  "<sha1[:12]>",
        "applied":    bool,
        "status":     "proposed" | "applied" | "verified" | "failed",
        "created_at": float,
        "verified_at": float | null,
        "last_failure_reason": str }

    We map by `finding_id` — engine's identifier matches the value the
    wrapper stored on the findings row at ingest time. Findings without
    a matching row (proposed for a vuln that didn't make it into our
    DB) are logged + skipped. Multiple patches per finding (re-proposal
    after a verify-fail) keep last-write-wins — final state is what the
    UI shows.
    """
    path = run_dir / "patches.jsonl"
    if not path.exists():
        logger.info("scan %s: no patches.jsonl — skipping patch ingest", scan_id)
        return

    proposals: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        "scan %s: patches.jsonl line %d: malformed JSON, skipping",
                        scan_id, line_no,
                    )
                    continue
                if not isinstance(obj, dict):
                    continue
                if not isinstance(obj.get("finding_id"), str) or not obj["finding_id"]:
                    continue
                if not isinstance(obj.get("diff"), str):
                    continue
                proposals.append(obj)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to read patches.jsonl", scan_id)
        return

    if not proposals:
        logger.info("scan %s: patches.jsonl present but empty — nothing to ingest", scan_id)
        return

    # Last write wins per finding_id — the engine appends; the most
    # recent line is the latest state.
    by_finding: dict[str, dict[str, Any]] = {}
    for obj in proposals:
        by_finding[obj["finding_id"]] = obj

    try:
        applied = sb.attach_patches_to_findings(scan_id, by_finding)
        logger.info(
            "scan %s: attached %d patches to findings (%d in file, %d unique)",
            scan_id, applied, len(proposals), len(by_finding),
        )
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: patch attach failed", scan_id)


def _upload_sarif_to_code_scanning(
    sb: WorkerSupabase,
    scan_id: str,
    scan: dict[str, Any],
    run_dir: Path,
) -> None:
    """Phase A #5 — push SARIF artefacts to GitHub Code Scanning.

    Preconditions for a non-skip path (all must be true):
      1. The parent target is a `repository`.
      2. The parent target carries an `integration_id` (migration 061).
      3. The integration is a github.com OAuth integration.
      4. The engine wrote at least one `*.sarif` file in run_dir.

    Failure modes are all log-and-skip:
      - No SARIF in run_dir → silent (older engines or scans that
        didn't run SAST).
      - No integration_id → silent.
      - Non-GitHub host → silent (we only know how to hit
        api.github.com today; gitlab + bitbucket have analogous
        surfaces we don't yet integrate).
      - GitHub API rejects (auth scope insufficient, repo not opted
        in to Code Scanning, etc.) → log the response body so the
        operator can fix it; the scan still finalises clean.

    GitHub Code Scanning API: POST /repos/{owner}/{repo}/code-scanning/
    sarifs. Body shape:
      { commit_sha, ref, sarif (base64+gzip), tool_name, started_at }
    Response: 202 + {id, url}. The result is asynchronously processed;
    we stamp the row right away and the user-visible URL is the
    repo's `/security/code-scanning` surface (works even before the
    server-side processing completes).
    """
    sarif_files = list(run_dir.rglob("*.sarif"))
    if not sarif_files:
        return

    parent = scan.get("targets") or {}
    if parent.get("type") != "repository":
        return
    integration_id = parent.get("integration_id")
    if not integration_id:
        logger.info(
            "scan %s: SARIF found but target has no integration_id — skipping upload",
            scan_id,
        )
        return

    repo_url = parent.get("value") or ""
    parsed = _parse_github_repo_url(repo_url)
    if parsed is None:
        logger.info(
            "scan %s: SARIF found but target value %r isn't a GitHub URL — "
            "Code Scanning upload only supports github.com today",
            scan_id, repo_url,
        )
        return

    try:
        token_blob = sb.decrypt_integration(scan_id, integration_id)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to decrypt github integration", scan_id)
        return
    try:
        token = json.loads(token_blob).get("access_token")
    except (json.JSONDecodeError, AttributeError):
        logger.warning("scan %s: integration token isn't JSON", scan_id)
        return
    if not token:
        return

    owner, repo = parsed
    # Engine PR #117 — `--branch` ref. Worker sends `null` when the
    # user didn't pick a branch and the engine clones the repo's
    # default. We GET /repos/<o>/<r> to discover the default if
    # needed, then resolve the head SHA for the right ref.
    branch = scan.get("branch") or None
    ref_name, commit_sha = _resolve_github_ref(token, owner, repo, branch)
    if not commit_sha:
        logger.warning(
            "scan %s: couldn't resolve head SHA for github.com/%s/%s@%s — skipping",
            scan_id, owner, repo, branch or "default",
        )
        return

    # GitHub accepts one SARIF per request. Most strix scans produce
    # 0 or 1 file (one combined SAST run). We iterate defensively.
    for sarif_path in sarif_files:
        try:
            with sarif_path.open("rb") as f:
                raw = f.read()
            payload = base64.b64encode(gzip.compress(raw)).decode("ascii")
        except OSError:
            logger.exception("scan %s: couldn't read SARIF at %s", scan_id, sarif_path)
            continue

        body = {
            "commit_sha": commit_sha,
            "ref": f"refs/heads/{ref_name}",
            "sarif": payload,
            "tool_name": "tensorshield",
            "started_at": (scan.get("started_at") or "")[:19] + "Z"
            if scan.get("started_at")
            else None,
        }
        # Strip None — GitHub rejects nulls on some fields.
        body = {k: v for k, v in body.items() if v is not None}

        try:
            req = urllib.request.Request(
                f"https://api.github.com/repos/{owner}/{repo}/code-scanning/sarifs",
                data=json.dumps(body).encode("utf-8"),
                method="POST",
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "tensorshield-worker",
                    "Content-Type": "application/json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_body = resp.read().decode("utf-8", errors="replace")
                logger.info(
                    "scan %s: SARIF upload accepted by github.com/%s/%s (%d): %s",
                    scan_id, owner, repo, resp.status, resp_body[:200],
                )
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
            logger.warning(
                "scan %s: SARIF upload to github.com/%s/%s rejected (%s): %s",
                scan_id, owner, repo, e.code, err[:500],
            )
            return  # bail on first hard failure; don't try more files
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: SARIF upload network failure", scan_id)
            return

    # All uploads succeeded — stamp the row. The URL we surface is the
    # repo's Code Scanning landing page (the per-upload URL works too
    # but only after server-side ingest completes, which is async).
    url = f"https://github.com/{owner}/{repo}/security/code-scanning"
    try:
        sb.set_code_scanning_uploaded(scan_id, url)
        logger.info(
            "scan %s: stamped code_scanning_url=%s for %d SARIF file(s)",
            scan_id, url, len(sarif_files),
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "scan %s: failed to stamp code_scanning_url (upload still happened)",
            scan_id,
        )


def _parse_github_repo_url(value: str) -> tuple[str, str] | None:
    """Pull (owner, repo) out of a GitHub URL. Returns None for non-
    github.com URLs or SSH paths — we only support github.com Code
    Scanning today (gitlab + bitbucket have analogous APIs we'll wire
    later)."""
    import re
    cleaned = value.strip()
    m = re.match(
        r"^https?://github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$",
        cleaned,
    )
    if m:
        return m.group(1), m.group(2)
    m = re.match(r"^git@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?$", cleaned)
    if m:
        return m.group(1), m.group(2)
    return None


def _resolve_github_ref(
    token: str, owner: str, repo: str, branch: str | None
) -> tuple[str, str | None]:
    """Look up the head SHA of a branch via GitHub. Returns
    (resolved_branch_name, commit_sha). When `branch` is None we ask
    GitHub for the repo's default_branch first, then resolve the head
    of that.
    """
    base = f"https://api.github.com/repos/{owner}/{repo}"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "tensorshield-worker",
    }

    resolved_branch = branch
    if not resolved_branch:
        try:
            req = urllib.request.Request(base, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=15) as resp:
                meta = json.loads(resp.read())
                resolved_branch = meta.get("default_branch") or "main"
        except Exception:  # noqa: BLE001
            resolved_branch = "main"  # last-resort fallback

    try:
        req = urllib.request.Request(
            f"{base}/git/ref/heads/{resolved_branch}",
            headers=headers,
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            ref_obj = json.loads(resp.read())
            sha = ref_obj.get("object", {}).get("sha")
            return resolved_branch, sha
    except Exception:  # noqa: BLE001
        return resolved_branch, None


def _load_trajectories(run_dir: Path) -> dict[str, dict[str, Any]]:
    """Parse <run_dir>/trajectory.jsonl into a {finding_id: record} map.

    Engine PR #142 writes one record per finding at run end. The record
    is keyed by `finding_id` (matching the corresponding entry in
    vulnerabilities.json); we use that as the join key.

    Best-effort: a missing file returns {}; a malformed line is skipped
    with a debug log; any other exception is caught upstream so a bad
    trajectory file never blocks finding ingestion.
    """
    path = run_dir / "trajectory.jsonl"
    if not path.exists():
        return {}
    out: dict[str, dict[str, Any]] = {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("trajectory.jsonl: malformed line %r", line[:200])
                    continue
                if not isinstance(rec, dict):
                    continue
                fid = rec.get("finding_id")
                if isinstance(fid, str) and fid:
                    out[fid] = rec
    except Exception:  # noqa: BLE001
        logger.exception("failed to read trajectory.jsonl at %s", path)
        return out
    return out


def _ingest_findings_from_json(
    sb: WorkerSupabase,
    scan_id: str,
    vulns_json: Path,
    trajectories: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Read the engine's structured vulnerabilities.json and insert each
    finding via worker_insert_finding.

    Schema reference: ClatTribe/strix `strix/telemetry/tracer.py` (PR #137 +
    #142). Top-level shape: { schema_version, run_id, run_name, generated_at,
    count, findings[] }. Each finding carries the full §15.3 + §10 quality
    surface — `confidence`, `reasoning_trace`, `counter_proof`,
    `reproducibility_token`, `category`, `priority_label`,
    `verification_status`, `compliance_controls`, etc.

    Best-effort: any single finding that fails to parse is logged and
    skipped; the rest still land. JSON-level corruption falls back to
    markdown ingestion via the caller.
    """
    try:
        data = json.loads(vulns_json.read_text())
    except Exception:  # noqa: BLE001
        logger.exception("vulnerabilities.json corrupt for scan %s; falling back to md", scan_id)
        # Fall back to markdown — caller will hit this path if the file is
        # missing entirely; here we explicitly trigger it on parse error.
        vulns_dir = vulns_json.parent / "vulnerabilities"
        if vulns_dir.exists():
            for vuln_file in sorted(vulns_dir.glob("vuln-*.md")):
                _ingest_finding(sb, scan_id, vuln_file)
        return

    findings = data.get("findings") if isinstance(data, dict) else None
    if not isinstance(findings, list):
        logger.warning("scan %s: vulnerabilities.json has no findings array", scan_id)
        return

    for f in findings:
        if not isinstance(f, dict):
            continue
        try:
            _insert_finding_from_json(sb, scan_id, f, trajectories or {})
        except Exception:  # noqa: BLE001
            logger.exception(
                "scan %s: failed to insert finding %s",
                scan_id,
                f.get("id") or f.get("title", "<unnamed>"),
            )


def _insert_finding_from_json(
    sb: WorkerSupabase,
    scan_id: str,
    f: dict[str, Any],
    trajectories: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Map one engine finding dict → worker_insert_finding payload."""
    title = (f.get("title") or "").strip() or "Untitled finding"
    severity = (f.get("severity") or "info").lower().strip()
    if severity not in {"critical", "high", "medium", "low", "info"}:
        severity = "info"

    cwe = _none_if_blank(f.get("cwe"))
    cve = _none_if_blank(f.get("cve"))
    endpoint = _none_if_blank(f.get("endpoint"))
    target = _none_if_blank(f.get("target"))
    method = _none_if_blank(f.get("method"))
    cvss = f.get("cvss")
    if not isinstance(cvss, (int, float)):
        cvss = None

    # Prefer the engine's stable fingerprint. Fall back to our wrapper-side
    # hash for older engines that don't emit one — the same loose hash we've
    # always used so dedup behaviour stays consistent.
    fingerprint = _none_if_blank(f.get("fingerprint")) or _compute_fingerprint(
        cwe=cwe, endpoint=endpoint, target=target, title=title,
    )

    # Reuse the description markdown for the legacy column (UI's section
    # parser still consumes this for older findings). Engine's plain
    # description goes into description_plain.
    description = f.get("description") or ""
    description_md = description if isinstance(description, str) else ""

    # `code_locations` lives on the finding too; persist as `affected_files`
    # to match the wrapper-side schema we already have.
    affected_files = f.get("code_locations") or None

    payload: dict[str, Any] = {
        "description_md": description_md,
        "cvss": cvss,
        "cwe": cwe,
        "cve": cve,
        "target": target,
        "endpoint": endpoint,
        "method": method,
        "fingerprint": fingerprint,
        "affected_files": affected_files,
        # New engine-signal columns (migration 024 + 025).
        "category": f.get("category"),
        "description_plain": f.get("description_plain"),
        "recommended_action": f.get("recommended_action"),
        "priority_label": f.get("priority_label"),
        "verification_status": f.get("verification_status"),
        "confidence": f.get("confidence"),
        "reproducibility_token": f.get("reproducibility_token"),
        "fingerprint_version": f.get("fingerprint_version"),
        "is_canonical": f.get("is_canonical"),
        "reasoning_trace": f.get("reasoning_trace"),
        "counter_proof": f.get("counter_proof"),
        "kill_chain": f.get("kill_chain"),
        "compliance_controls": f.get("compliance_controls"),
        "data_classification": f.get("data_classification"),
        "mitre_attack": f.get("mitre_attack"),
        "owasp_top_10": f.get("owasp_top_10"),
        "owasp_api_top_10": f.get("owasp_api_top_10"),
        "features": f.get("features"),
        "engine_auto_dismissed": f.get("auto_dismissed"),
        "engine_auto_dismissal_reason": f.get("auto_dismissal_reason"),
        "severity_pre_auto_dismissal": f.get("severity_pre_auto_dismissal"),
        "prior_label_attribution": f.get("prior_label_attribution"),
        # The legacy markdown columns the worker used to extract.
        "technical_analysis_md": f.get("technical_analysis"),
        "poc_md": _compose_poc_md(f),
        "impact_md": f.get("impact"),
        "remediation_md": f.get("remediation_steps"),
        # Per-finding trajectory record (migration 029). Joined by
        # finding id from <run_dir>/trajectory.jsonl. Absence is fine —
        # the column stays null and the UI hides the panel.
        "trajectory": (trajectories or {}).get(f.get("id") or "") if isinstance(f.get("id"), str) else None,
    }

    sb.insert_finding(
        scan_id=scan_id,
        vuln_id=f.get("id") or fingerprint[:12],
        title=title,
        severity=severity,
        payload=payload,
    )


def _none_if_blank(v: Any) -> str | None:
    """Treat empty/whitespace strings and "n/a"/"none"/"-" as None.

    Strix occasionally writes those literals for unknown fields; the DB
    model wants a real null."""
    if not isinstance(v, str):
        return v if v is not None else None
    s = v.strip()
    if not s or s.lower() in {"n/a", "none", "-"}:
        return None
    return s


def _compose_poc_md(f: dict[str, Any]) -> str | None:
    """Combine `poc_description` + `poc_script_code` into the legacy
    `poc_md` column shape, for back-compat with the existing finding
    markdown parser. Each can be present independently."""
    desc = f.get("poc_description") or ""
    code = f.get("poc_script_code") or ""
    if not (desc.strip() or code.strip()):
        return None
    if code.strip():
        return (desc + ("\n\n" if desc.strip() else "") + "```\n" + code + "\n```").strip()
    return desc.strip() or None


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

        # Pull Strix's structured code_locations back out of the `## Code
        # Analysis` section and persist them as JSONB. Downstream the
        # triage RAG path consumes these snippets directly — no need to
        # re-read source from disk, and works for repository targets too
        # (whose sandbox-cloned source is gone by triage time).
        affected_files = parse_code_analysis_section(text)

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
                "affected_files": affected_files or None,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("failed to ingest %s: %s", vuln_file, e)
