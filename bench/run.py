"""TensorShield benchmark runner.

Two modes:

  1. score-only (default) — score an existing scan against ground truth.
     Pass --scan-id or --findings-file. Useful when you've already kicked
     off a scan from the UI / API and just want the scorecard.

     Examples:
       python bench/run.py --target altoro-mutual --scan-id <UUID>
       python bench/run.py --target juice-shop  --findings-file findings.json

  2. orchestrate (--run) — create a scan via the wrapper API, poll until
     finished, then score. Requires:
       BENCH_SUPABASE_URL  + BENCH_SUPABASE_SERVICE_ROLE_KEY  (or .env.local)
       BENCH_ORG_ID (which org runs the benchmark scans)
       BENCH_USER_ID (the user_id stamped on each scan)

     Example:
       python bench/run.py --target altoro-mutual --run

The CLI exits 0 when the score meets --min-f1; non-zero otherwise.
Useful for CI (fail the workflow on regression).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Avoid hard dependency on supabase-py for score-only mode. The
# orchestrate path imports it lazily so `python run.py --target X
# --findings-file out.json` works on a vanilla Python install.
try:
    import yaml  # type: ignore
except ImportError:
    print("ERROR: pyyaml required. Install: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from score import (  # noqa: E402
    GroundTruthVuln,
    Finding,
    ScoreReport,
    score,
    load_ground_truth,
    load_findings,
    to_markdown,
    summary_json,
)

TARGETS_DIR = ROOT / "targets"
GROUND_TRUTH_DIR = ROOT / "ground_truth"
RESULTS_DIR = ROOT / "results"


def load_target(slug: str) -> dict[str, Any]:
    p = TARGETS_DIR / f"{slug}.yaml"
    if not p.exists():
        raise FileNotFoundError(
            f"target {slug} not found at {p}. "
            f"Available: {sorted(t.stem for t in TARGETS_DIR.glob('*.yaml'))}"
        )
    return yaml.safe_load(p.read_text())


def resolve_findings_from_scan(scan_id: str) -> list[Finding]:
    """Fetch findings for a scan via the wrapper's service-role Supabase client."""
    try:
        from supabase import create_client  # type: ignore
    except ImportError:
        print("ERROR: supabase-py required for --scan-id mode.", file=sys.stderr)
        print("Install: pip install supabase", file=sys.stderr)
        sys.exit(1)

    url = os.environ.get("BENCH_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("BENCH_SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    )
    if not url or not key:
        print(
            "ERROR: BENCH_SUPABASE_URL + BENCH_SUPABASE_SERVICE_ROLE_KEY required.",
            file=sys.stderr,
        )
        sys.exit(1)

    sb = create_client(url, key)
    rows = (
        sb.table("findings")
        .select("id, title, severity, cwe, cve, endpoint, description_md")
        .eq("scan_id", scan_id)
        .execute()
        .data
    ) or []
    return [Finding.from_dict(r) for r in rows]


def orchestrate(target: dict[str, Any]) -> str:
    """Create a scan via the API, poll until finished, return scan_id.

    Lazy-imports supabase-py to avoid forcing the install on score-only users.
    """
    try:
        from supabase import create_client  # type: ignore
    except ImportError:
        print("ERROR: supabase-py required for --run mode.", file=sys.stderr)
        sys.exit(1)

    url = os.environ.get("BENCH_SUPABASE_URL")
    key = os.environ.get("BENCH_SUPABASE_SERVICE_ROLE_KEY")
    org_id = os.environ.get("BENCH_ORG_ID")
    user_id = os.environ.get("BENCH_USER_ID")
    if not all([url, key, org_id, user_id]):
        print(
            "ERROR: --run requires BENCH_SUPABASE_URL, BENCH_SUPABASE_SERVICE_ROLE_KEY, "
            "BENCH_ORG_ID, BENCH_USER_ID env vars.",
            file=sys.stderr,
        )
        sys.exit(1)

    sb = create_client(url, key)

    # Ensure the target exists.
    existing = (
        sb.table("targets")
        .select("id")
        .eq("org_id", org_id)
        .eq("value", target["url"])
        .limit(1)
        .execute()
        .data
    )
    if existing:
        target_row_id = existing[0]["id"]
    else:
        target_row = (
            sb.table("targets")
            .insert(
                {
                    "org_id": org_id,
                    "name": target["name"],
                    "type": target["target_type"],
                    "value": target["url"],
                    "created_by": user_id,
                    "scan_frequency": "manual",
                    "status": "active",
                }
            )
            .execute()
            .data
        )
        target_row_id = target_row[0]["id"]

    # Insert the scan + scan_targets row. Pre-set max_cost from the YAML.
    scan_row = (
        sb.table("scans")
        .insert(
            {
                "org_id": org_id,
                "target_id": target_row_id,
                "user_id": user_id,
                "run_name": f"bench:{target['slug']}",
                "status": "queued",
                "scan_mode": target.get("scan_mode", "standard"),
                "max_cost": float(target.get("max_cost_usd", 1.0)),
                "instruction_text": target.get("instruction"),
            }
        )
        .execute()
        .data
    )
    scan_id = scan_row[0]["id"]

    sb.table("scan_targets").insert(
        {
            "scan_id": scan_id,
            "type": target["target_type"],
            "value": target["url"],
        }
    ).execute()

    print(f"queued scan {scan_id} for {target['slug']}; polling…")

    # Poll until terminal.
    deadline = time.time() + 60 * 60  # 60 min ceiling
    while time.time() < deadline:
        row = (
            sb.table("scans")
            .select("status, total_cost, finished_at, error_message")
            .eq("id", scan_id)
            .single()
            .execute()
            .data
        )
        if row["status"] in ("completed", "failed", "cancelled"):
            print(
                f"scan {scan_id} → {row['status']} "
                f"(${row.get('total_cost') or 0:.2f}, {row.get('error_message') or 'no error'})"
            )
            return scan_id
        print(f"  status={row['status']} cost=${row.get('total_cost') or 0:.2f} — waiting…")
        time.sleep(20)
    raise TimeoutError("scan did not finish in 60min budget")


def run_for_target(slug: str, scan_id: str | None, findings_file: Path | None, run_now: bool) -> ScoreReport:
    target = load_target(slug)
    gt_path = ROOT / target["ground_truth_file"]
    if not gt_path.exists():
        raise FileNotFoundError(f"ground truth missing: {gt_path}")

    if run_now:
        scan_id = orchestrate(target)

    if scan_id:
        findings = resolve_findings_from_scan(scan_id)
    elif findings_file:
        findings = load_findings(findings_file)
    else:
        raise SystemExit("supply --scan-id, --findings-file, or --run")

    gt = load_ground_truth(gt_path)
    return score(slug, gt, findings)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", help="benchmark slug (e.g. altoro-mutual). Use --all to score every target.")
    parser.add_argument("--all", action="store_true", help="score every target with results files in bench/results/.")
    parser.add_argument("--scan-id", help="scan_id to score against (from your DB).")
    parser.add_argument("--findings-file", type=Path, help="path to JSON file with findings array.")
    parser.add_argument("--run", action="store_true", help="orchestrate: create the scan via API then score.")
    parser.add_argument("--min-f1", type=float, default=0.0, help="exit non-zero if F1 < min-f1.")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "BENCHMARKS.md",
                        help="write the markdown summary here (default bench/results/BENCHMARKS.md).")
    args = parser.parse_args()

    if not args.target and not args.all:
        parser.error("--target or --all required")

    reports: list[ScoreReport] = []

    if args.target:
        reports.append(run_for_target(args.target, args.scan_id, args.findings_file, args.run))

    if args.all:
        # Score every target whose findings file exists under bench/results/<slug>.json.
        for yaml_path in sorted(TARGETS_DIR.glob("*.yaml")):
            slug = yaml_path.stem
            findings_path = RESULTS_DIR / f"{slug}.findings.json"
            if not findings_path.exists():
                print(f"skip {slug}: no findings at {findings_path}", file=sys.stderr)
                continue
            reports.append(run_for_target(slug, None, findings_path, run_now=False))

    if not reports:
        print("no reports produced.", file=sys.stderr)
        sys.exit(2)

    md = to_markdown(reports)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(md)

    # Also write a JSON summary alongside.
    json_out = args.output.with_suffix(".json")
    json_out.write_text(summary_json(reports))

    print(md)
    print(f"\n→ wrote {args.output}")
    print(f"→ wrote {json_out}")

    worst = min(r.f1_strict for r in reports)
    if worst < args.min_f1:
        print(f"\nFAIL: lowest F1 {worst:.2f} < threshold {args.min_f1:.2f}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
