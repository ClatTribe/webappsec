"""LLM-based finding triage to reduce alert fatigue.

Pulls every finding without an `ai_assessment` and asks a Gemini (or any
LiteLLM-supported) model to rate:

  - reachability    : external_unauthenticated | external_authenticated
                       | internal_only | unreachable
  - urgency         : fix_now | fix_soon | monitor | dismiss
  - false-positive likelihood
  - one-sentence reasoning + recommended action

Stores the structured JSON back on `findings.ai_assessment`. The UI uses
`urgency` to sort and filter so users see only what actually needs attention.

Run:
  cd webapp/worker
  STRIX_LLM=gemini/gemini-2.5-flash \\
    LLM_API_KEY=$LLM_API_KEY \\
    SUPABASE_URL=http://127.0.0.1:54321 \\
    SUPABASE_SERVICE_ROLE_KEY=$SR_KEY \\
    python scripts/assess_findings.py [--reassess]

Pass --reassess to re-run on findings that already have an assessment.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

import litellm
from supabase import create_client


SYSTEM_PROMPT = """\
You are a senior application security engineer triaging vulnerability \
findings produced by an automated security agent. Your job is to filter \
out false positives, assess realistic reachability, and prioritise what \
actually needs to be fixed. You are deliberately conservative — when in \
doubt, mark as monitor, not dismiss.

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

Apply the rubric. Return only JSON.
"""


def _coerce_assessment(raw: str) -> dict[str, Any]:
    """LiteLLM sometimes returns ```json ... ``` fenced blocks; strip them."""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:]
    return json.loads(s.strip())


# Fall through this list when the primary model returns 5xx / overload / 404 errors.
# Note: gemini-2.0-flash was retired for new users in 2026 — it's omitted.
_FALLBACK_MODELS = [
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-flash-lite",
    "gemini/gemini-2.5-pro",
]


async def assess_one(finding: dict[str, Any], model: str, api_key: str) -> dict[str, Any]:
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


def _need_assess(finding: dict[str, Any]) -> bool:
    return not finding.get("ai_assessment")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--reassess",
        action="store_true",
        help="Re-run on findings that already have an assessment",
    )
    parser.add_argument(
        "--scan-id",
        help="Limit to findings from this scan_id",
    )
    args = parser.parse_args()

    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    model = os.environ.get("STRIX_LLM", "gemini/gemini-2.5-flash")
    if not (sb_url and sb_key):
        print("error: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set", file=sys.stderr)
        return 2
    api_key = os.environ.get("LLM_API_KEY")
    if not api_key:
        print("error: LLM_API_KEY must be set", file=sys.stderr)
        return 2

    sb = create_client(sb_url, sb_key)
    q = sb.table("findings").select("*").order("created_at", desc=True)
    if args.scan_id:
        q = q.eq("scan_id", args.scan_id)
    rows = q.execute().data or []
    targets = rows if args.reassess else [r for r in rows if _need_assess(r)]

    print(f"model: {model}")
    print(f"candidates: {len(targets)} of {len(rows)} ({'reassess' if args.reassess else 'fresh only'})")
    if not targets:
        return 0

    success = 0
    for f in targets:
        ident = f"{f.get('vuln_id')} ({(f.get('severity') or '').upper()})"
        try:
            assessment = await assess_one(f, model, api_key)
            sb.table("findings").update(
                {
                    "ai_assessment": assessment,
                    "ai_assessed_at": "now()",
                }
            ).eq("id", f["id"]).execute()
            success += 1
            print(
                f"  {ident:>22}  urgency={assessment.get('urgency'):<9}  "
                f"reach={assessment.get('reachability'):<27}  "
                f"fp={'yes' if assessment.get('is_likely_false_positive') else 'no'}  "
                f"conf={assessment.get('confidence'):.2f}"
            )
        except Exception as e:  # noqa: BLE001
            print(f"  {ident:>22}  FAILED: {e}", file=sys.stderr)

    print(f"\n{success} / {len(targets)} assessed")
    return 0 if success == len(targets) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
