"""Tier II #7 — worker → wrapper hook to post the sticky PR comment.

After `finish_scan()` flips a scan to a terminal state, this module
checks whether the scan was PR-driven (has a `github_pull_request_number`)
and if so POSTs to the wrapper's /api/scans/[id]/pr-comment route. The
wrapper does the heavy lifting (markdown compose + GitHub REST upsert);
the worker just nudges.

Why an HTTP callback rather than a worker-side GitHub POST?
  - The wrapper already has GitHub helpers (`lib/github.ts`), the
    markdown composer (`lib/pr-comment.ts`), and the integration token
    decrypt RPC wired up. Re-implementing in Python doubles the code
    that has to stay in lockstep with the comment format.
  - The wrapper API is the place we want HMAC + idempotency to live —
    a future Slack-bot or Linear-bot post-finalize hook would share
    the same auth pattern.

Best-effort: any error inside is logged and swallowed; never block
the scan-finalize path. Mirrors notifier.py's discipline.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)

_HTTP_TIMEOUT_SEC = 10.0


def dispatch_pr_comment(
    sb: WorkerSupabase,
    *,
    scan_id: str,
    wrapper_origin: str | None,
) -> None:
    """Best-effort: ping the wrapper to (re)post the sticky PR comment.

    Args:
        sb: live WorkerSupabase client used to (a) check whether the
            scan has PR context and (b) read the shared worker_internal_secret.
        scan_id: the just-finished scan id.
        wrapper_origin: deployed wrapper base URL, e.g. https://app.tensorshield.ai.
            If None or empty, this is a silent no-op (local dev without the
            wrapper running, or a worker pointed at a different deployment).
    """
    if not wrapper_origin:
        return

    # ---- 1. Cheap check: does this scan have PR context? ------------
    # If not, nothing to comment on — return without touching the wrapper.
    try:
        scan_row = _fetch_scan_pr_state(sb, scan_id)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: PR-context fetch failed; skipping comment", scan_id)
        return
    if scan_row is None or not scan_row.get("github_pull_request_number"):
        return

    # ---- 2. Read the worker-internal shared secret ------------------
    try:
        secret = _fetch_worker_secret(sb)
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: failed to read worker_internal_secret", scan_id)
        return
    if not secret:
        logger.warning(
            "scan %s: tensorshield_settings.worker_internal_secret is empty — skipping PR comment",
            scan_id,
        )
        return

    # ---- 3. Fire-and-forget POST ------------------------------------
    url = f"{wrapper_origin.rstrip('/')}/api/scans/{scan_id}/pr-comment"
    headers = {
        "Content-Type": "application/json",
        "X-Worker-Secret": secret,
        "User-Agent": "strix-worker",
    }
    try:
        resp = httpx.post(url, headers=headers, json={}, timeout=_HTTP_TIMEOUT_SEC)
    except httpx.RequestError:
        logger.exception("scan %s: PR comment dispatch HTTP failed", scan_id)
        return

    if resp.status_code >= 400:
        # 412 (no PR context, no integration) is non-fatal — the row
        # likely changed between our pre-check and the wrapper's read.
        # 502 (GitHub upstream) means the wrapper tried but GitHub
        # said no — still non-fatal here; user can retry from the UI.
        body = resp.text[:512]
        logger.warning(
            "scan %s: PR comment dispatch returned %s — %s",
            scan_id,
            resp.status_code,
            body,
        )
        return

    logger.info("scan %s: PR comment dispatched ok (%s)", scan_id, resp.status_code)


def _fetch_scan_pr_state(sb: WorkerSupabase, scan_id: str) -> dict[str, Any] | None:
    """Read just the PR-context columns for the scan. None when the row
    is missing (shouldn't happen post-finish_scan but defensive)."""
    resp = (
        sb.client.from_("scans")
        .select(
            "id, github_owner, github_repo, github_pull_request_number, github_head_sha"
        )
        .eq("id", scan_id)
        .maybe_single()
        .execute()
    )
    return resp.data if resp else None


def _fetch_worker_secret(sb: WorkerSupabase) -> str | None:
    """Read the singleton tensorshield_settings row. RLS denies all
    non-service-role access, so this works only because the worker
    uses a service-role key."""
    resp = (
        sb.client.from_("tensorshield_settings")
        .select("worker_internal_secret")
        .eq("id", 1)
        .maybe_single()
        .execute()
    )
    data = resp.data if resp else None
    if not data:
        return None
    return data.get("worker_internal_secret")
