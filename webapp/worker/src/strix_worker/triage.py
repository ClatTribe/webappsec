"""LLM-based finding triage — used inline by the scan runner and by the
standalone `scripts/assess_findings.py` CLI.

The contract:

    Given a finding row, ask an LLM to produce a structured assessment of
    reachability, urgency, false-positive likelihood, and a short reasoning +
    recommended action. Persist that JSON to `findings.ai_assessment`.

The runner calls `triage_scan_findings(sb, scan_id, ...)` after every scan
completes, before the scan row is flipped to `completed`. So by the time
findings appear in the UI they're already triaged — users don't see a
window of unassessed clutter.

Deduplicated recurring findings keep their existing `ai_assessment` (the
worker_insert_finding RPC doesn't reset it on a dedup hit), so the
`only_unassessed=True` filter naturally skips them. That's the right call
— the human triage state is more authoritative than re-running an LLM on
the same fingerprint, and it saves tokens.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import litellm

from .supabase_client import WorkerSupabase

logger = logging.getLogger(__name__)


# Fall through this list when the primary model returns 5xx / overload / 404
# errors. Note: gemini-2.0-flash was retired for new users in 2026 — omitted.
_FALLBACK_MODELS = [
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-flash-lite",
    "gemini/gemini-2.5-pro",
]


SYSTEM_PROMPT = """\
You are a senior application security engineer triaging vulnerability \
findings produced by an automated security agent. Your job is to filter \
out false positives, assess realistic reachability, and prioritise what \
actually needs to be fixed. You are deliberately conservative — when in \
doubt, mark as monitor, not dismiss.

When a "Source code context" section is present, treat it as ground \
truth — the actual lines from the file the report cites. Use it to \
*confirm* (or refute) the report's claim before assigning urgency: does \
the dangerous call really happen there? Is the user input actually \
flowing into it, or is the cited line in dead code, a test fixture, or \
an example file? When the source contradicts the report, lean toward \
`dismiss` or `monitor` and say so in `reasoning`. When source is absent, \
fall back to judging from the report alone.

Codebase under test (webappsec):
- Multi-tenant SaaS that wraps the open-source Strix AI security agent
- Three tiers: Next.js 14 frontend on Vercel, Postgres+RLS via Supabase, \
Python worker on Fly.io
- Authenticated users (email/password) submit scans against their own \
external targets
- Postgres RLS isolates tenants; the service-role key lives only in the \
worker and server-side API routes
- The worker spawns Strix as a subprocess inside a Docker sandbox with \
per-scan credentials
- Repository: https://github.com/ClatTribe/webappsec

Reachability values:
- external_unauthenticated: anyone on the internet can hit it pre-auth
- external_authenticated: any signed-up user can trigger it
- internal_only: requires service-role key, direct DB access, or the worker
- unreachable: dead code path, dev-only setting, or in a file that is not deployed

Urgency values:
- fix_now: real, reachable, high-impact, deployed code path
- fix_soon: real but lower impact OR partial mitigation already in place
- monitor: needs human review or upstream change to actually fix
- dismiss: false positive, intentional dev convenience, placeholder credential, \
or CVSS overstated by a generic dependency scanner

Common false positive patterns you should recognise and dismiss:
- Placeholder credentials in .env.example or seed.sql files (e.g. postgres:postgres)
- Dev-only Supabase / config.toml settings explicitly marked "set true in production"
- npm-audit's CVSS scores on transitive devDependencies that aren't in the runtime path
- Generic dependency CVEs that don't apply to the specific usage
- "Hardcoded secret" findings that point at example/template files

Respond ONLY with valid JSON matching this exact schema, no prose:
{
  "urgency": "fix_now" | "fix_soon" | "monitor" | "dismiss",
  "reachability": "external_unauthenticated" | "external_authenticated" | "internal_only" | "unreachable",
  "confidence": <number between 0.0 and 1.0>,
  "is_likely_false_positive": <boolean>,
  "reasoning": "<1-2 sentences explaining your call>",
  "recommended_action": "<one specific concrete action sentence>"
}
"""


USER_TEMPLATE = """\
Finding to triage
=================

Title: {title}
Reported severity: {severity}
CVSS: {cvss}
CWE: {cwe}
Target: {target}
Endpoint: {endpoint}
Method: {method}
Times seen across scans: {times_seen}
Current human-triage status: {status}

Full markdown report:
---
{description_md}
---
{code_context_section}
Apply the rubric. Return only JSON.
"""


def _format_code_context(code_context: str | None) -> str:
    """Return the code-context section as a leading block, or empty string."""
    if not code_context:
        return ""
    return (
        "\nSource code context (actual lines from the cited files):\n"
        "---\n"
        f"{code_context}\n"
        "---\n"
    )


def _coerce_assessment(raw: str) -> dict[str, Any]:
    """LiteLLM sometimes returns ```json ... ``` fenced blocks; strip them."""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:]
    return json.loads(s.strip())


async def assess_one(
    finding: dict[str, Any],
    *,
    model: str,
    api_key: str,
    code_context: str | None = None,
) -> dict[str, Any]:
    """Ask the LLM to triage a single finding. Returns the parsed assessment.

    If `code_context` is provided, it's injected into the prompt as the
    actual source lines around the cited file/line. The LLM uses it to
    confirm or refute the report's claim — the system prompt tells it to
    treat the snippet as ground truth.
    """
    user = USER_TEMPLATE.format(
        title=finding.get("title") or "",
        severity=(finding.get("severity") or "").upper(),
        cvss=finding.get("cvss") or "n/a",
        cwe=finding.get("cwe") or "n/a",
        target=finding.get("target") or "n/a",
        endpoint=finding.get("endpoint") or "n/a",
        method=finding.get("method") or "n/a",
        times_seen=finding.get("times_seen") or 1,
        status=finding.get("status") or "open",
        description_md=(finding.get("description_md") or "")[:8000],
        code_context_section=_format_code_context(code_context),
    )

    # Try the primary model first, then walk the fallback list on 5xx /
    # rate-limit / overload errors. Each model gets up to 3 retries inside
    # litellm itself for transient blips.
    candidates = [model] + [m for m in _FALLBACK_MODELS if m != model]
    last_err: Exception | None = None
    for attempt_model in candidates:
        try:
            resp = await litellm.acompletion(
                model=attempt_model,
                api_key=api_key,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                response_format={"type": "json_object"},
                temperature=0.2,
                max_tokens=2048,
                num_retries=3,
            )
            assessment = _coerce_assessment(resp.choices[0].message.content)
            assessment["model"] = attempt_model
            return assessment
        except (
            litellm.ServiceUnavailableError,
            litellm.RateLimitError,
            litellm.APIError,
            litellm.NotFoundError,
            litellm.InternalServerError,
        ) as e:
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("no model returned a result")


def need_assess(finding: dict[str, Any]) -> bool:
    return not finding.get("ai_assessment")


@dataclass
class TriageStats:
    """Outcome of a triage pass over one scan's findings."""
    candidates: int
    success: int
    failed: int
    skipped: int

    @property
    def attempted(self) -> int:
        return self.success + self.failed


async def triage_scan_findings(
    sb: WorkerSupabase,
    scan_id: str,
    *,
    model: str,
    api_key: str,
    reassess: bool = False,
    scan_targets: list[dict[str, Any]] | None = None,
) -> TriageStats:
    """Triage every finding *detected in this scan* that lacks an assessment.

    "Detected in" means `last_seen_scan_id == scan_id` — so a recurring
    finding (deduped against an earlier row) is included even though its
    `scan_id` points at the original scan. With `reassess=False` (the default)
    those already-assessed recurrences are silently skipped, which is the
    right behaviour: the existing assessment is still valid, no need to burn
    tokens.

    When `scan_targets` is provided and any of them is `local_code`, the
    triage call gets a "Source code context" section built from the cited
    files in the finding markdown. This lets the LLM confirm reachability
    against the actual source instead of guessing from prose. See
    `code_context.gather_for_finding` for the contract and bounds.

    Failures are non-fatal at the per-finding level — one bad LLM call
    shouldn't stop the rest. The caller should treat the whole pass as
    best-effort: a failed triage just means the finding renders without an
    AI verdict, exactly as it would have before this feature shipped.
    """
    # Local import — avoids a hard dep when this module is used in tests
    # that don't exercise the RAG path.
    from .code_context import gather_for_finding

    rows = (
        sb.client.table("findings")
        .select("*")
        .eq("last_seen_scan_id", scan_id)
        .execute()
        .data
        or []
    )
    candidates = rows if reassess else [r for r in rows if need_assess(r)]
    skipped = len(rows) - len(candidates)

    if not candidates:
        return TriageStats(candidates=0, success=0, failed=0, skipped=skipped)

    success = 0
    failed = 0
    rag_hits = 0
    for f in candidates:
        ident = f.get("vuln_id") or f.get("id")
        code_context: str | None = None
        if scan_targets:
            try:
                code_context = gather_for_finding(f, scan_targets=scan_targets)
                if code_context:
                    rag_hits += 1
            except Exception:  # noqa: BLE001
                # Code-context assembly is best-effort — never let a bad
                # file read block triage on the finding itself.
                logger.exception("triage %s: code-context gather failed", ident)

        try:
            assessment = await assess_one(
                f, model=model, api_key=api_key, code_context=code_context
            )
            sb.client.table("findings").update(
                {"ai_assessment": assessment, "ai_assessed_at": "now()"}
            ).eq("id", f["id"]).execute()
            success += 1
            logger.info(
                "triage %s urgency=%s reach=%s fp=%s conf=%.2f rag=%s",
                ident,
                assessment.get("urgency"),
                assessment.get("reachability"),
                "yes" if assessment.get("is_likely_false_positive") else "no",
                float(assessment.get("confidence") or 0.0),
                "yes" if code_context else "no",
            )
        except Exception as e:  # noqa: BLE001
            failed += 1
            logger.warning("triage %s FAILED: %s", ident, e)

    if rag_hits:
        logger.info(
            "triage scan=%s injected source context for %d/%d findings",
            scan_id, rag_hits, len(candidates),
        )
    return TriageStats(candidates=len(candidates), success=success, failed=failed, skipped=skipped)
