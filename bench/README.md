# TensorShield benchmark harness

Measures TensorShield's findings against hand-curated ground-truth lists
for 5 well-known public testbeds. Produces precision / recall / F1 and a
markdown report you can publish.

## Targets

| Slug | What | Hosting |
|---|---|---|
| `altoro-mutual` | IBM Altoro Mutual demo banking | Public (`demo.testfire.net`) |
| `juice-shop` | OWASP Juice Shop | Local Docker |
| `dvwa` | Damn Vulnerable Web Application | Local Docker |
| `nodegoat` | OWASP NodeGoat (Node.js-specific) | Local Docker |
| `testphp-vulnweb` | Acunetix testphp.vulnweb.com | Public |

YAML configs under `targets/`. Ground truth (curated vulnerability lists)
under `ground_truth/`.

## Install

```bash
pip install pyyaml supabase
```

`pyyaml` is required. `supabase` is only required for `--scan-id` and
`--run` modes (which talk to your wrapper's DB).

## Modes

### Score an already-run scan

The simplest workflow. Run scans manually via the TensorShield UI / API,
then point the scorer at the resulting `scan_id`:

```bash
export BENCH_SUPABASE_URL=https://your-project.supabase.co
export BENCH_SUPABASE_SERVICE_ROLE_KEY=eyJ...

python bench/run.py --target altoro-mutual --scan-id 6c9f0d4c-...
```

### Score offline (findings JSON file)

Useful in CI or when you don't have direct DB access. Export findings
as JSON and pass them in:

```bash
python bench/run.py --target juice-shop --findings-file results/juice-shop.findings.json
```

The findings file is an array of objects with `id, title, severity,
cwe, cve, endpoint, description_md` fields. The wrapper's
`/api/scans/<id>/findings` endpoint returns this shape.

### Orchestrate (create + run + score)

Creates the scan via the wrapper's DB, polls until completion, scores.
Long-running; respects the YAML's `max_cost_usd`.

```bash
export BENCH_ORG_ID=...      # which org runs benchmark scans
export BENCH_USER_ID=...     # the user_id stamped on scans

python bench/run.py --target altoro-mutual --run
```

### Score every target at once

When you've populated `bench/results/<slug>.findings.json` for each
target (or run `--all --run`), `--all` scores them all and writes a
combined report.

```bash
python bench/run.py --all
```

### Fail CI on regression

```bash
python bench/run.py --all --min-f1 0.6
```

Exits non-zero when the lowest F1 across targets drops below 0.6.

## Scoring policy

Matching is forgiving — DAST tools rarely tag findings with the same
CWE+endpoint string. A ground-truth entry counts as covered when any
actual finding matches via:

1. matching CWE **and** any title keyword present in the finding text, or
2. matching endpoint substring **and** any title keyword, or
3. all title keywords present in the finding's title / description.

Extras (findings not in ground truth) are reported but **not always
penalised** as false positives — real DAST surfaces genuine bugs the
ground truth didn't list. We report both numbers so a regression in
either is visible.

## Adding a target

1. Drop a `targets/<slug>.yaml` with `slug`, `name`, `url`, `target_type`,
   `description`, `scan_mode`, `max_cost_usd`, `instruction`,
   `ground_truth_file`.
2. Drop the matching ground truth at `ground_truth/<slug>.json` with a
   `vulns` array of `{id, cwe, title, endpoint?, method?, title_keywords[]}`.
3. Run `python bench/run.py --target <slug> --scan-id <UUID>` to verify
   the matcher binds correctly. Tune `title_keywords` if it misses real
   findings.

## Output

Results land at `bench/results/BENCHMARKS.md` plus a sibling
`.json`. The repo-root `BENCHMARKS.md` (one level up from this dir)
holds the published historical version — update it from a clean run
before each release.
