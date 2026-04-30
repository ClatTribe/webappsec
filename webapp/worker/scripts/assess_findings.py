"""Standalone CLI for LLM-based finding triage.

Most of the time you don't need this — the worker now triages findings
inline at scan finalize (see `runner.run_scan` → `triage_scan_findings`).
This script exists for two cases:

  1. Backfilling triage for findings created before the inline pass shipped.
  2. Forcing a re-triage with `--reassess` (e.g. after tweaking the prompt).

The actual triage logic lives in `strix_worker.triage`; this is a thin
CLI wrapper around it.

Run:
  cd webapp/worker
  STRIX_LLM=gemini/gemini-2.5-flash \\
    LLM_API_KEY=$LLM_API_KEY \\
    SUPABASE_URL=http://127.0.0.1:54321 \\
    SUPABASE_SERVICE_ROLE_KEY=$SR_KEY \\
    python scripts/assess_findings.py [--reassess] [--scan-id UUID]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from strix_worker.triage import assess_one, need_assess
from supabase import create_client


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--reassess",
        action="store_true",
        help="Re-run on findings that already have an assessment",
    )
    parser.add_argument(
        "--scan-id",
        help="Limit to findings whose original scan_id matches this UUID.",
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
    targets = rows if args.reassess else [r for r in rows if need_assess(r)]

    print(f"model: {model}")
    print(f"candidates: {len(targets)} of {len(rows)} ({'reassess' if args.reassess else 'fresh only'})")
    if not targets:
        return 0

    success = 0
    for f in targets:
        ident = f"{f.get('vuln_id')} ({(f.get('severity') or '').upper()})"
        try:
            assessment = await assess_one(f, model=model, api_key=api_key)
            sb.table("findings").update(
                {"ai_assessment": assessment, "ai_assessed_at": "now()"}
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
