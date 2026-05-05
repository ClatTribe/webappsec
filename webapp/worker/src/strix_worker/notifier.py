"""Slack notifier — Tier A scan-completion push channel.

Operators don't sit on the dashboard; without a push channel a critical
finding can sit invisible until somebody happens to refresh the UI.
This module composes a small Slack-blocks payload from the finished
scan's row + finding counts and POSTs it to the org's webhook.

Per Architecture.md §1.1 the engine writes the findings; the wrapper
only summarises + routes. We don't re-derive any per-finding signal here.

Best-effort everywhere:
  - No webhook configured for the org → silent no-op
  - Vault returns a non-Slack URL → silent no-op (RPC re-validates)
  - HTTP request fails → log + continue, never block scan finalisation

The module is deliberately stateless: callers pass in everything it
needs (sb client, scan_id, finish stats). That keeps it test-friendly
without a fixture dance.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


# Slack rejects payloads larger than ~40 KB. We aim for well under
# that — single-message summary + a short list of top findings.
_HTTP_TIMEOUT_SEC = 5.0
_MAX_FINDING_LINES = 5


# Severity-to-emoji mapping. Slack renders emoji in markdown blocks
# without any special escaping — keeping these inline as Unicode
# avoids relying on the Slack workspace having custom :ssn: shortcodes.
_SEV_EMOJI = {
    "critical": "🛑",
    "high":     "🔴",
    "medium":   "🟠",
    "low":      "🟡",
    "info":     "🔵",
}


def notify_scan_completion(
    sb: WorkerSupabase,
    *,
    scan_id: str,
    org_id: str,
    final_status: str,
    error_message: str | None,
    wrapper_origin: str | None,
) -> None:
    """Compose and POST a Slack message for the just-finished scan.

    `wrapper_origin` is the deployed wrapper's base URL (e.g.
    ``https://strix.example.com``); the message includes a click-through
    link to the scan page when set. Without it we still notify but the
    "View scan" button is omitted.

    The function never raises. Every error path logs and returns —
    we'd rather lose a notification than fail a scan over a
    transient Slack 5xx.
    """
    webhook = sb.decrypt_org_slack_webhook(scan_id)
    if not webhook:
        logger.debug("scan %s: no Slack webhook configured for org %s", scan_id, org_id)
        return

    try:
        scan = (
            sb.client.table("scans")
            .select("id, run_name, scan_mode, total_cost, status")
            .eq("id", scan_id)
            .single()
            .execute()
            .data
        ) or {}
    except Exception:  # noqa: BLE001
        scan = {}

    counts = _count_findings_by_severity(sb, scan_id)
    payload = _compose_message(
        scan=scan,
        scan_id=scan_id,
        final_status=final_status,
        error_message=error_message,
        counts=counts,
        wrapper_origin=wrapper_origin,
    )

    try:
        with httpx.Client(timeout=_HTTP_TIMEOUT_SEC) as client:
            resp = client.post(webhook, json=payload)
            if resp.status_code >= 400:
                logger.warning(
                    "scan %s: Slack webhook returned %d: %s",
                    scan_id, resp.status_code, resp.text[:200],
                )
    except Exception:  # noqa: BLE001
        logger.exception("scan %s: Slack webhook POST failed", scan_id)


def _count_findings_by_severity(sb: WorkerSupabase, scan_id: str) -> dict[str, int]:
    """Aggregate finding counts by severity for the scan summary line.

    A single SELECT is cheaper than five filtered counts; we bucket
    client-side. Capped at 500 rows so a runaway scan with 10k findings
    doesn't blow the worker's memory — the message-line summary only
    cares about whether a bucket has any findings, not the exact >500
    count.
    """
    counts = {sev: 0 for sev in _SEV_EMOJI}
    try:
        result = (
            sb.client.table("findings")
            .select("severity")
            .eq("scan_id", scan_id)
            .limit(500)
            .execute()
        )
        for row in result.data or []:
            sev = (row.get("severity") or "").lower()
            if sev in counts:
                counts[sev] += 1
    except Exception:  # noqa: BLE001
        logger.warning("scan %s: failed to load finding counts for Slack", scan_id, exc_info=True)
    return counts


def _compose_message(
    *,
    scan: dict[str, Any],
    scan_id: str,
    final_status: str,
    error_message: str | None,
    counts: dict[str, int],
    wrapper_origin: str | None,
) -> dict[str, Any]:
    """Compose the Slack-blocks payload.

    Slack docs: https://api.slack.com/reference/block-kit/blocks
    We render two blocks: a section with title + subtitle + counts, and
    an actions block with the "View scan" button when wrapper_origin is
    set. Total payload stays well under Slack's 40 KiB limit.
    """
    run_name = scan.get("run_name") or scan_id
    scan_mode = scan.get("scan_mode") or "scan"

    headline_emoji, headline = _headline(final_status, error_message, counts)
    subtitle_lines: list[str] = [
        f"*Run:* `{run_name}`",
        f"*Mode:* `{scan_mode}`",
    ]
    if scan.get("total_cost") is not None:
        try:
            cost_f = float(scan["total_cost"])
            if cost_f > 0:
                subtitle_lines.append(f"*Cost:* `${cost_f:.4f}`")
        except (TypeError, ValueError):
            pass

    sev_line = " · ".join(
        f"{_SEV_EMOJI[sev]} {counts[sev]} {sev}"
        for sev in ("critical", "high", "medium", "low", "info")
        if counts[sev] > 0
    )
    if not sev_line:
        sev_line = "_no findings_"

    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"{headline_emoji} *{headline}*\n" + "\n".join(subtitle_lines)
                        + f"\n*Findings:* {sev_line}",
            },
        }
    ]
    if wrapper_origin:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "View scan"},
                        "url": f"{wrapper_origin.rstrip('/')}/scans/{scan_id}",
                    }
                ],
            }
        )

    # `text` is the fallback shown in Slack notifications, push, etc.
    # Always supply something useful — the blocks-only path renders an
    # empty notification preview otherwise.
    fallback = f"{headline} — run {run_name}"
    return {"text": fallback, "blocks": blocks}


def _headline(
    final_status: str,
    error_message: str | None,
    counts: dict[str, int],
) -> tuple[str, str]:
    """Return (emoji, single-line headline) for the scan's final state."""
    if final_status == "completed":
        critical = counts.get("critical", 0)
        high = counts.get("high", 0)
        if critical > 0:
            return ("🚨", f"Scan completed — {critical} critical finding{'s' if critical != 1 else ''}")
        if high > 0:
            return ("⚠️", f"Scan completed — {high} high finding{'s' if high != 1 else ''}")
        any_findings = any(v > 0 for v in counts.values())
        if any_findings:
            return ("✅", "Scan completed — only low/info findings")
        return ("✅", "Scan completed cleanly — no findings")
    if final_status == "cancelled":
        return ("🛑", "Scan cancelled")
    if error_message and "budget" in error_message.lower():
        return ("💸", "Scan stopped — budget exceeded")
    return ("❌", f"Scan failed — {error_message or 'no structured error'}")
