"""Plain-language scan summary — the 30-second forwardable report.

After triage finalises, summarise the scan in two short paragraphs the
user can screenshot for their team chat. Persists to `scans.summary`
JSONB; the scan detail page renders it above the findings list.

Why wrapper-side, not Strix:

  Strix already produces a `penetration_test_report.md` artifact (a
  long-form pentest report). What we want here is different — a *triaged*
  summary that includes the AI-assessed urgency breakdown ("1 fix-now,
  2 monitor"), which is a wrapper-only concept. The upstream `run.summary`
  event from `tools-wishlist.md` P1 would let us replace this LLM call
  with a parse, but until then the call is cheap and we control the tone.

The summary is honest about what we know vs guess:

  - Counts of findings + AI-assessed urgency: high-confidence (we have
    these in our DB).
  - "Exploit drafted" vs "Verified" — we degrade the claim to "drafted"
    when we have `poc_script_code` but no upstream verification signal
    (see roadmap pillar 1 item 3 — promote to "Verified" when Strix
    exposes the bool).
  - Endpoints touched — derived from `tool.execution.*` events
    cross-referenced against the scan's targets. Honest "we hit N
    endpoints"; not the dishonest "we tested for X clean" claim that
    needs upstream check.* events.
"""

from __future__ import annotations

import json
import logging
import pathlib
from dataclasses import dataclass
from typing import Any

import litellm

from .supabase_client import WorkerSupabase
from .triage import _FALLBACK_MODELS, _coerce_assessment

logger = logging.getLogger(__name__)


SUMMARY_SYSTEM_PROMPT = """\
You write the plain-language scan summary that a security-aware staff
engineer would screenshot and forward to their team's Slack. Two short
paragraphs, no preamble, no marketing fluff. Calibrated honest tone —
prefer precise admissions of uncertainty over confident-sounding
generalities.

Structure:

  Paragraph 1 (what we did + what we found):
    - Target(s) scanned, briefly
    - Total finding count + breakdown by AI-assessed urgency
    - Top finding's title + severity, in one phrase
    - "Exploit drafted" if poc_script_code is present (we don't claim
      "verified" — we don't have a structured signal for that yet)

  Paragraph 2 (what's notable + what to do):
    - Recurrence note if any findings were re-detected
    - One concrete next action for the user
    - Skip filler. If there's nothing notable, just state that.

Hard rules:

  - Do NOT claim what was "tested for X — clean". We have no structured
    signal for negative coverage; saying so would be dishonest.
  - Do NOT promise verified exploitability. Use "exploit drafted" for
    findings with PoC code, "pattern match" for those without.
  - Maximum 110 words total. Punchy beats comprehensive.
  - No emoji. No headings. Just two paragraphs separated by a blank line.

Return ONLY a JSON object:
{
  "text": "<the two-paragraph summary>"
}
"""


@dataclass
class SummaryStats:
    findings_total: int
    fix_now: int
    fix_soon: int
    monitor: int
    dismiss_or_fp: int
    endpoints_touched: int


def _gather_scan_facts(sb: WorkerSupabase, scan_id: str) -> dict[str, Any]:
    """Pull the structured facts the LLM should summarise.

    Best-effort: any sub-query failure degrades that section but doesn't
    abort the summary. The model gets fewer facts and writes a shorter
    summary; the user still sees something.
    """
    out: dict[str, Any] = {
        "targets": [],
        "findings": [],
        "endpoints_touched": 0,
        "recurrence": None,
    }

    try:
        scan_row = (
            sb.client.table("scans").select("*, scan_targets(*)").eq("id", scan_id).single().execute().data
        )
        out["scan"] = scan_row
        out["targets"] = scan_row.get("scan_targets") or []
    except Exception:  # noqa: BLE001
        logger.exception("summary: failed to load scan %s", scan_id)

    try:
        out["findings"] = (
            sb.client.table("findings")
            .select("title, severity, status, ai_assessment, poc_md")
            .eq("last_seen_scan_id", scan_id)
            .execute()
            .data
            or []
        )
    except Exception:  # noqa: BLE001
        logger.exception("summary: failed to load findings for scan %s", scan_id)

    # Endpoints touched: distinct URLs the agent actually called against
    # this scan. From scan_events, tool.execution.* with a `url` payload
    # field. Heuristic — the wishlist's P0 check.* events would replace
    # this with semantic coverage data.
    try:
        events = (
            sb.client.table("scan_events")
            .select("event_type, payload")
            .eq("scan_id", scan_id)
            .like("event_type", "tool.execution%")
            .execute()
            .data
            or []
        )
        urls: set[str] = set()
        for ev in events:
            payload = ev.get("payload") or {}
            for key in ("url", "endpoint", "target_url"):
                v = payload.get(key)
                if isinstance(v, str) and v.startswith(("http://", "https://", "/")):
                    urls.add(v)
        out["endpoints_touched"] = len(urls)
    except Exception:  # noqa: BLE001
        logger.exception("summary: failed to load events for scan %s", scan_id)

    try:
        rec = sb.client.rpc("scan_recurrence_summary", {"p_scan_id": scan_id}).execute()
        out["recurrence"] = rec.data if isinstance(rec.data, dict) else None
    except Exception:  # noqa: BLE001
        logger.exception("summary: scan_recurrence_summary RPC failed for %s", scan_id)

    return out


def _compute_stats(facts: dict[str, Any]) -> SummaryStats:
    findings = facts.get("findings") or []
    fix_now = fix_soon = monitor = dismiss_or_fp = 0
    for f in findings:
        urgency = ((f.get("ai_assessment") or {}).get("urgency") or "").lower()
        if urgency == "fix_now":
            fix_now += 1
        elif urgency == "fix_soon":
            fix_soon += 1
        elif urgency == "monitor":
            monitor += 1
        elif urgency == "dismiss":
            dismiss_or_fp += 1

    return SummaryStats(
        findings_total=len(findings),
        fix_now=fix_now,
        fix_soon=fix_soon,
        monitor=monitor,
        dismiss_or_fp=dismiss_or_fp,
        endpoints_touched=facts.get("endpoints_touched") or 0,
    )


def _build_user_prompt(facts: dict[str, Any], stats: SummaryStats) -> str:
    """Compact, structured input for the summarising LLM."""
    scan = facts.get("scan") or {}
    targets = facts.get("targets") or []
    findings = facts.get("findings") or []
    rec = facts.get("recurrence")

    target_lines = [f"  - {t.get('type')}: {t.get('value')}" for t in targets]

    finding_lines = []
    # Sort by severity so the top item is first; LLMs anchor on first.
    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    for f in sorted(findings, key=lambda r: sev_order.get((r.get("severity") or "info").lower(), 9)):
        severity = (f.get("severity") or "info").upper()
        urgency = ((f.get("ai_assessment") or {}).get("urgency") or "n/a")
        has_poc = bool(f.get("poc_md"))
        finding_lines.append(
            f"  - [{severity}] {f.get('title')} (AI: {urgency}, "
            f"{'PoC drafted' if has_poc else 'no PoC'})"
        )

    rec_line = ""
    if rec and rec.get("total"):
        rec_line = (
            f"\nRecurrence: {rec['total']} of these findings were also seen in prior scans "
            f"(still active: {rec.get('still_active', 0)}, fixed: {rec.get('fixed', 0)}, "
            f"dismissed: {rec.get('dismissed', 0)}, reopened: {rec.get('reopened', 0)})."
        )

    return (
        f"Scan name: {scan.get('run_name')}\n"
        f"Scan mode: {scan.get('scan_mode')}\n"
        f"Target(s):\n" + ("\n".join(target_lines) or "  (none)") + "\n\n"
        f"Endpoints touched during the scan: {stats.endpoints_touched}\n\n"
        f"Findings ({stats.findings_total} total):\n"
        f"  fix_now: {stats.fix_now}, fix_soon: {stats.fix_soon}, "
        f"monitor: {stats.monitor}, dismiss/FP: {stats.dismiss_or_fp}\n\n"
        f"Detail (sorted by severity):\n" + ("\n".join(finding_lines) or "  (none)")
        + rec_line + "\n\nWrite the summary."
    )


def _normalize_engine_summary(engine_summary: dict[str, Any]) -> dict[str, Any]:
    """Map the engine's run_summary.json shape to the scans.summary JSONB
    shape the UI expects. Preserves the engine's `summary_text` verbatim;
    derives stats from the engine's structured `findings_summary` and
    `checks` blocks. Source is tagged as `engine` so the UI / future
    drift-detection can distinguish."""
    fs = engine_summary.get("findings_summary") or {}
    by_sev = fs.get("by_severity") or {}
    by_cat = fs.get("by_category") or {}
    checks = engine_summary.get("checks") or {}
    by_check_result = checks.get("by_result") or {}

    findings_total = fs.get("total")
    if findings_total is None:
        findings_total = sum(by_sev.values()) if by_sev else 0

    # Map engine severity counts onto the wrapper UI's existing
    # fix_now / fix_soon / monitor / dismiss_or_fp buckets. The engine
    # doesn't distinguish AI-urgency, so we approximate with severity
    # ordinality (critical+high → fix_now, medium → fix_soon, low → monitor,
    # info → none of the above; AI triage will refine post-hoc).
    fix_now = (by_sev.get("critical") or 0) + (by_sev.get("high") or 0)
    fix_soon = by_sev.get("medium") or 0
    monitor = by_sev.get("low") or 0

    return {
        "text": engine_summary.get("summary_text") or "",
        "model": "engine",  # not an LLM model — flags this as engine-authored
        "generated_at": engine_summary.get("generated_at") or "now()",
        "source": "engine_run_summary_json",
        "stats": {
            "findings_total": int(findings_total or 0),
            "fix_now": int(fix_now),
            "fix_soon": int(fix_soon),
            "monitor": int(monitor),
            "dismiss_or_fp": 0,
            "endpoints_touched": 0,
            "by_severity": by_sev,
            "by_category": by_cat,
            "checks_total": int(checks.get("total") or 0),
            "checks_clean": int(by_check_result.get("not_vulnerable") or 0),
            "checks_inconclusive": int(by_check_result.get("inconclusive") or 0),
        },
        "top_findings": engine_summary.get("top_findings") or [],
        "duration_seconds": engine_summary.get("duration_seconds"),
    }


def _read_engine_run_summary(scan_id: str) -> dict[str, Any] | None:
    """Read the engine's run_summary.json artifact if present.

    Path: /tmp/strix-runs/<scan_id>/strix_runs/<run_name>/run_summary.json.
    The engine writes this at run end (PR #31) with `summary_text`,
    `findings_summary.by_severity / by_category`, `top_findings`, etc.
    Per the doctrine, we prefer the engine's authored summary over our
    wrapper-side LLM call.

    Returns None when the file is absent or unreadable; caller falls back
    to the LLM-driven path.
    """
    base = pathlib.Path(f"/tmp/strix-runs/{scan_id}/strix_runs")
    if not base.exists():
        return None
    for run_dir in base.iterdir():
        if not run_dir.is_dir():
            continue
        summary_path = run_dir / "run_summary.json"
        if not summary_path.is_file():
            continue
        try:
            return json.loads(summary_path.read_text())
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: run_summary.json unreadable", scan_id)
            return None
    return None


async def summarize_scan(
    sb: WorkerSupabase,
    scan_id: str,
    *,
    model: str,
    api_key: str,
) -> dict[str, Any] | None:
    """Generate + persist the plain-language summary for one scan.

    Three paths, in priority order:

      1. Engine's `run_summary.json` artifact — preferred. The engine
         authors a richer summary including `summary_text`, severity +
         category breakdown, top findings. Wrapper drops in directly.
      2. Wrapper-side LLM call — fallback. Writes a tighter summary
         tuned for the screenshot-and-forward use case.
      3. Null — when both above fail; UI degrades gracefully.

    Failures are non-fatal at the caller — a missing summary just means
    the scan-page section is hidden, exactly as for scans that completed
    before this feature shipped.
    """
    # Path 1: engine-authored summary.
    engine_summary = _read_engine_run_summary(scan_id)
    if engine_summary and engine_summary.get("summary_text"):
        payload = _normalize_engine_summary(engine_summary)
        try:
            sb.client.table("scans").update({"summary": payload}).eq("id", scan_id).execute()
        except Exception:  # noqa: BLE001
            logger.exception("scan %s: failed to write engine summary", scan_id)
            return None
        logger.info(
            "summary scan=%s source=engine findings=%s",
            scan_id, payload["stats"].get("findings_total"),
        )
        return payload

    # Path 2: wrapper LLM fallback.
    facts = _gather_scan_facts(sb, scan_id)
    stats = _compute_stats(facts)

    if stats.findings_total == 0:
        # A scan with zero findings deserves a summary too — that's the
        # "clean bill of health" moment. We still want the LLM to write
        # it because the wording matters ("0 findings, but here's what
        # we touched"). Skip if we have literally no facts.
        if not facts.get("scan"):
            return None

    user_prompt = _build_user_prompt(facts, stats)

    candidates = [model] + [m for m in _FALLBACK_MODELS if m != model]
    last_err: Exception | None = None
    for attempt_model in candidates:
        try:
            resp = await litellm.acompletion(
                model=attempt_model,
                api_key=api_key,
                messages=[
                    {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.3,  # slightly looser than triage; this is prose
                max_tokens=400,
                num_retries=2,
            )
            parsed = _coerce_assessment(resp.choices[0].message.content)
            text = (parsed.get("text") or "").strip()
            if not text:
                last_err = RuntimeError("empty summary text")
                continue
            payload = {
                "text": text,
                "model": attempt_model,
                "generated_at": "now()",
                "stats": {
                    "findings_total": stats.findings_total,
                    "fix_now": stats.fix_now,
                    "fix_soon": stats.fix_soon,
                    "monitor": stats.monitor,
                    "dismiss_or_fp": stats.dismiss_or_fp,
                    "endpoints_touched": stats.endpoints_touched,
                },
            }
            sb.client.table("scans").update({"summary": payload}).eq("id", scan_id).execute()
            logger.info(
                "summary scan=%s findings=%d endpoints=%d model=%s chars=%d",
                scan_id, stats.findings_total, stats.endpoints_touched,
                attempt_model, len(text),
            )
            return payload
        except (
            litellm.ServiceUnavailableError,
            litellm.RateLimitError,
            litellm.APIError,
            litellm.NotFoundError,
            litellm.InternalServerError,
        ) as e:
            last_err = e
            continue
        except Exception as e:  # noqa: BLE001
            last_err = e
            break

    logger.warning("summary scan=%s FAILED: %s", scan_id, last_err)
    return None
