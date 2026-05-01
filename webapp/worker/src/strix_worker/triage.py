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

import asyncio
import json
import logging
import random
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
{code_context_section}{triage_priors_section}
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


def _format_triage_priors(priors: dict[str, Any] | None) -> str:
    """Format prior decisions on the same fingerprint as a prompt section.

    The KNN model handles "similar findings" via embeddings. THIS section
    is for *exact-fingerprint* prior decisions — much stronger signal.
    "User dismissed this exact fingerprint 3 times" is near-deterministic;
    the LLM should weight it heavily over the report's own claims.
    """
    if not priors:
        return ""
    parts: list[str] = []
    real = (priors.get("triaged_real") or 0) + (priors.get("fixed") or 0)
    dismissed = (priors.get("false_positive") or 0) + (priors.get("wont_fix") or 0)
    total = priors.get("total") or 0
    if total == 0:
        return ""
    parts.append(
        f"This exact fingerprint has been triaged {total} time(s) before by this org's team:"
    )
    if dismissed:
        parts.append(
            f"  - {dismissed} dismissed (false_positive: {priors.get('false_positive') or 0}, "
            f"wont_fix: {priors.get('wont_fix') or 0})"
        )
    if real:
        parts.append(
            f"  - {real} confirmed real (triaged_real: {priors.get('triaged_real') or 0}, "
            f"fixed: {priors.get('fixed') or 0})"
        )
    if priors.get("last_decided_at"):
        parts.append(f"  - Most recent decision: {priors['last_decided_at']}")
    parts.append(
        "Treat this as strong signal. If the team consistently dismissed this "
        "fingerprint, lean dismiss; if they consistently confirmed it real, "
        "lean fix_now/fix_soon."
    )
    return "\nPrior triage on this fingerprint:\n" + "\n".join(parts) + "\n"


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
    triage_priors: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ask the LLM to triage a single finding. Returns the parsed assessment.

    If `code_context` is provided, it's injected into the prompt as the
    actual source lines around the cited file/line. The LLM uses it to
    confirm or refute the report's claim — the system prompt tells it to
    treat the snippet as ground truth.

    If `triage_priors` is provided (from `triage_priors_for_finding` RPC),
    it carries this org's prior decisions on the *exact same fingerprint*
    as labelled signal. Stronger than the KNN model's similarity-based
    suggestions because exact-match matters more.
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
        triage_priors_section=_format_triage_priors(triage_priors),
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


# ---------------------------------------------------------------------------
# Embeddings — vector representation for the per-tenant KNN model
# ---------------------------------------------------------------------------

# Gemini's free-tier embedding model. 768 dims, same key the org already
# uses for triage. If we switch providers later, only this constant + the
# `findings.embedding` column dimensions need to move together.
EMBEDDING_MODEL = "gemini/text-embedding-004"
EMBEDDING_DIMS = 768

# Soft cap on what we feed the embedder. Embedding APIs typically accept
# up to ~8K tokens; we stay well under to avoid surprises and keep cost
# predictable. Truncation discards trailing remediation prose, which
# matters less for similarity than the title + description + snippet.
_EMBED_INPUT_CHAR_BUDGET = 6000


def _embed_input(finding: dict[str, Any]) -> str:
    """Build the text we embed for a finding.

    What we want the vector to capture: *what the bug is and where it
    lives*, not the prose styling. So: title + the most-informative
    structured fields + a slice of the description + any snippet Strix
    attached. Keeps the embedding stable across LLM rewordings.
    """
    parts: list[str] = []
    title = finding.get("title")
    if title:
        parts.append(f"Title: {title}")
    cwe = finding.get("cwe")
    if cwe:
        parts.append(f"CWE: {cwe}")
    target = finding.get("target")
    if target:
        parts.append(f"Target: {target}")
    endpoint = finding.get("endpoint")
    if endpoint:
        method = finding.get("method") or "ANY"
        parts.append(f"Endpoint: {method} {endpoint}")

    # Snippet from Strix's structured code_locations carries the most
    # discriminative signal — the actual vulnerable lines.
    affected = finding.get("affected_files") or []
    if isinstance(affected, list):
        for entry in affected[:2]:
            if isinstance(entry, dict) and entry.get("snippet"):
                parts.append(f"Code: {entry['snippet']}")

    desc = finding.get("description_md") or ""
    if desc:
        parts.append(f"Description: {desc[:3000]}")

    text = "\n".join(parts)
    return text[:_EMBED_INPUT_CHAR_BUDGET] if len(text) > _EMBED_INPUT_CHAR_BUDGET else text


async def embed_finding(
    finding: dict[str, Any],
    *,
    api_key: str,
    model: str = EMBEDDING_MODEL,
) -> list[float] | None:
    """Compute a 768-d embedding for a finding. Returns None on failure.

    Failures are *never* fatal to triage. A finding without an embedding
    still gets its `ai_assessment` written; it just doesn't contribute
    to the per-org KNN model until the next time it (or a similar one)
    is re-embedded.
    """
    text = _embed_input(finding)
    if not text:
        return None

    try:
        resp = await litellm.aembedding(
            model=model,
            api_key=api_key,
            input=text,
            num_retries=2,
        )
        # LiteLLM normalises responses to OpenAI shape: {data: [{embedding: [...]}]}
        data = resp.data if hasattr(resp, "data") else resp.get("data")
        if not data:
            return None
        vec = data[0].get("embedding") if isinstance(data[0], dict) else data[0].embedding
        if not vec or len(vec) != EMBEDDING_DIMS:
            logger.warning(
                "embedding for %s returned unexpected dim: got=%d want=%d",
                finding.get("vuln_id") or finding.get("id"),
                0 if not vec else len(vec),
                EMBEDDING_DIMS,
            )
            return None
        return list(vec)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "embedding for %s FAILED: %s",
            finding.get("vuln_id") or finding.get("id"),
            e,
        )
        return None


def _vec_literal(vec: list[float]) -> str:
    """Format a Python float list as a pgvector literal: '[0.1,0.2,...]'.

    The supabase-py client ships JSON over PostgREST; pgvector accepts
    its bracketed text form on assignment. We send a string to keep the
    payload portable across client versions.
    """
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


# ---------------------------------------------------------------------------
# Auto-dismiss — phase 3 of the triage learning loop
# ---------------------------------------------------------------------------
#
# Policy (intentionally conservative):
#
#   1. The per-org KNN must say `p_false_positive >= AUTO_DISMISS_THRESHOLD`.
#   2. The same finding fingerprint must already be dismissed by this org.
#      Pure-similarity isn't enough; we need a hard precedent. Without
#      this guard, one bad embedding could cascade into widespread
#      dismissal of a brand-new bug class.
#   3. `severity != 'critical'`. Hard catastrophe floor — we never auto-
#      dismiss a critical finding regardless of confidence. The expected
#      cost of hiding a real critical is unbounded.
#   4. ε-greedy escape valve: AUTO_DISMISS_EPSILON of eligible
#      auto-dismissals are *not* dismissed, surfaced to the user
#      instead. Prevents the filter-bubble drift where the model
#      auto-dismisses everything that looks like X, the user never sees
#      X, no new labels for X arrive, and the model's view of X drifts
#      forever from reality. The ε path generates a labeled signal
#      every time the user touches it, which is exactly the active-
#      learning behaviour we want.

AUTO_DISMISS_THRESHOLD = 0.95
AUTO_DISMISS_EPSILON = 0.05  # 5%: surface anyway, log for accuracy audit

# Suggestion threshold (UI surfaces "Likely false positive — confirm?")
SUGGESTION_THRESHOLD = 0.70


def _has_same_fingerprint_dismissed(
    sb: WorkerSupabase, org_id: str, fingerprint: str | None
) -> bool:
    """Has this org dismissed any finding with the same fingerprint before?

    Required guard before auto-dismiss. Without it, a new bug class with
    high similarity to an old dismissed class would chain-dismiss on its
    first detection. The fingerprint hash is loose enough that two
    LLM-rewordings of the same finding agree, tight enough that
    different bugs don't.
    """
    if not fingerprint:
        return False
    rows = (
        sb.client.table("findings")
        .select("id")
        .eq("org_id", org_id)
        .eq("fingerprint", fingerprint)
        .in_("status", ["false_positive", "wont_fix", "dismissed_by_ai"])
        .limit(1)
        .execute()
        .data
        or []
    )
    return len(rows) > 0


def _eligible_for_auto_dismiss(
    finding: dict[str, Any],
    prediction: dict[str, Any] | None,
    *,
    has_same_fingerprint_dismissed: bool,
) -> bool:
    """Pure-policy gate, no I/O. All four hard rules from the doctrine."""
    if prediction is None:
        return False
    p_fp = prediction.get("p_false_positive")
    if p_fp is None or float(p_fp) < AUTO_DISMISS_THRESHOLD:
        return False
    if (finding.get("severity") or "").lower() == "critical":
        return False
    if not has_same_fingerprint_dismissed:
        return False
    return True


def _maybe_auto_dismiss(
    sb: WorkerSupabase,
    finding: dict[str, Any],
    prediction: dict[str, Any] | None,
) -> bool:
    """Apply the policy. Returns True if the finding was auto-dismissed.

    Writes the audit row (`auto_dismiss_reason`) regardless of whether
    ε-greedy fired — when it does fire, the row records `epsilon_explore:
    true` so a future drift audit can compare ε-explore outcomes against
    auto-dismiss outcomes (calibration check).
    """
    org_id = finding.get("org_id")
    fingerprint = finding.get("fingerprint")
    if not (org_id and fingerprint):
        return False

    has_precedent = _has_same_fingerprint_dismissed(sb, org_id, fingerprint)
    eligible = _eligible_for_auto_dismiss(
        finding, prediction, has_same_fingerprint_dismissed=has_precedent
    )
    if not eligible:
        return False

    # ε-greedy: with probability AUTO_DISMISS_EPSILON, surface anyway.
    # We still record an audit row tagged `epsilon_explore: true` so the
    # divergence is measurable later.
    if random.random() < AUTO_DISMISS_EPSILON:
        sb.client.table("findings").update(
            {
                "auto_dismiss_reason": {
                    **(prediction or {}),
                    "threshold": AUTO_DISMISS_THRESHOLD,
                    "epsilon_explore": True,
                }
            }
        ).eq("id", finding["id"]).execute()
        logger.info(
            "auto-dismiss eligible but ε-explored: %s p_fp=%.3f",
            finding.get("vuln_id") or finding.get("id"),
            float(prediction["p_false_positive"]),
        )
        return False

    sb.client.table("findings").update(
        {
            "status": "dismissed_by_ai",
            "auto_dismiss_reason": {
                **(prediction or {}),
                "threshold": AUTO_DISMISS_THRESHOLD,
            },
        }
    ).eq("id", finding["id"]).execute()
    logger.info(
        "auto-dismissed %s p_fp=%.3f n=%d",
        finding.get("vuln_id") or finding.get("id"),
        float(prediction["p_false_positive"]),
        int(prediction.get("n_neighbours") or 0),
    )
    return True


def _fetch_prediction(sb: WorkerSupabase, finding_id: str) -> dict[str, Any] | None:
    """Call predict_triage_for_finding. Service-role bypasses RLS, so we
    rely on the `where org_id = …` clause inside the function for isolation
    (which it has — see migration 019). Returns None on cold start or
    any RPC error (caller must treat as 'no signal').
    """
    try:
        result = sb.client.rpc(
            "predict_triage_for_finding", {"p_finding_id": finding_id}
        ).execute()
        return result.data if isinstance(result.data, dict) else None
    except Exception:  # noqa: BLE001
        logger.exception("predict_triage_for_finding RPC failed for %s", finding_id)
        return None


def _fetch_triage_priors(sb: WorkerSupabase, finding_id: str) -> dict[str, Any] | None:
    """Call triage_priors_for_finding. Returns None when no prior signal."""
    try:
        result = sb.client.rpc(
            "triage_priors_for_finding", {"p_finding_id": finding_id}
        ).execute()
        return result.data if isinstance(result.data, dict) else None
    except Exception:  # noqa: BLE001
        logger.exception("triage_priors_for_finding RPC failed for %s", finding_id)
        return None


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
            # Fetch prior triage decisions on this fingerprint — strong
            # prompt signal when present. Sync RPC; if the org has no
            # priors it returns None and assess_one omits the section.
            priors = _fetch_triage_priors(sb, f["id"])

            # Run the LLM judgment and the embedding in parallel — both
            # take a network round-trip; no reason to serialise. The
            # embedding is best-effort: if it fails the assessment still
            # lands and the finding renders with an AI verdict, just
            # without contributing to the per-org KNN model.
            assess_task = asyncio.create_task(
                assess_one(
                    f, model=model, api_key=api_key,
                    code_context=code_context, triage_priors=priors,
                )
            )
            embed_task = asyncio.create_task(embed_finding(f, api_key=api_key))
            assessment = await assess_task
            embedding = await embed_task

            update_payload: dict[str, Any] = {
                "ai_assessment": assessment,
                "ai_assessed_at": "now()",
            }
            if embedding is not None:
                update_payload["embedding"] = _vec_literal(embedding)

            sb.client.table("findings").update(
                update_payload
            ).eq("id", f["id"]).execute()
            success += 1

            # Auto-dismiss decision. Runs *after* the assessment + embedding
            # land so the KNN sees this finding's vector and the prediction
            # is computed against the most current org state. Only attempt
            # when we have an embedding — without it the KNN can't run.
            auto_dismissed = False
            if embedding is not None:
                # Build a feature dict the policy can read. We just wrote
                # the embedding, so the in-memory `f` row needs the org_id
                # which is already there from the scan-find query.
                prediction = _fetch_prediction(sb, f["id"])
                auto_dismissed = _maybe_auto_dismiss(sb, f, prediction)

            logger.info(
                "triage %s urgency=%s reach=%s fp=%s conf=%.2f rag=%s emb=%s auto=%s",
                ident,
                assessment.get("urgency"),
                assessment.get("reachability"),
                "yes" if assessment.get("is_likely_false_positive") else "no",
                float(assessment.get("confidence") or 0.0),
                "yes" if code_context else "no",
                "yes" if embedding is not None else "no",
                "yes" if auto_dismissed else "no",
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
