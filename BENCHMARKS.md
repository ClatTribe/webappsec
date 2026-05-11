# TensorShield benchmarks

How TensorShield performs against publicly-known vulnerable web apps.
Updated on every release; methodology + ground-truth in `bench/`.

## Latest results

_Run the harness to populate this section:_

```bash
pip install pyyaml supabase
export BENCH_SUPABASE_URL=https://your-project.supabase.co
export BENCH_SUPABASE_SERVICE_ROLE_KEY=eyJ...
python bench/run.py --all
# → writes bench/results/BENCHMARKS.md
# Copy the rendered table here.
```

Until then this is a placeholder table showing the shape:

| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| altoro-mutual | 15 | — | — | — | — | — | — | — |
| juice-shop | 12 | — | — | — | — | — | — | — |
| dvwa | 10 | — | — | — | — | — | — | — |
| nodegoat | 10 | — | — | — | — | — | — | — |
| testphp-vulnweb | 8 | — | — | — | — | — | — | — |

Total ground truth across all targets: **55 known vulnerabilities**.

## Methodology

Every benchmark target ships with:

- A **YAML config** (`bench/targets/<slug>.yaml`) — URL, scan mode,
  cost cap, license note, and one-line instructions for the agent.
- A **curated ground-truth JSON** (`bench/ground_truth/<slug>.json`) —
  each vulnerability with a CWE, title hint, optional endpoint, and a
  short keyword list the matcher uses to decide whether a TensorShield
  finding plausibly covers it.

Matching is deliberately **forgiving** — real DAST findings rarely tag
the same CWE+endpoint string as a curated list. A ground-truth entry
counts as covered when:

1. matching CWE **and** any title keyword present in the finding, or
2. matching endpoint substring **and** any title keyword, or
3. **all** title keywords present in the finding's title/description.

Extras (findings not in ground truth) are reported but **not punitively
counted as false positives** in the F1 calculation — DAST tools often
surface genuine bugs the ground truth missed.

### Precision and recall

- **Recall** = covered ground-truth / total ground-truth. How much of
  the known-bad TensorShield actually found.
- **Precision (strict)** = covered ground-truth / (covered + extras).
  Penalises every extra finding as a potential FP.
- **F1 (strict)** = harmonic mean of the two.

The strict precision is a lower bound — real-world precision is
higher because some extras are legitimate findings the curated list
didn't anticipate.

## Targets in detail

### IBM Altoro Mutual (`altoro-mutual`)
- URL: `https://demo.testfire.net` (public)
- 15 ground-truth items across SQLi, XSS, LFI, default-creds, info
  disclosure, missing headers, CSRF.
- Stable since 2008; widely used as a DAST baseline.

### OWASP Juice Shop (`juice-shop`)
- Local Docker (`docker run -p 3000:3000 bkimminich/juice-shop`)
- 12 ground-truth items — subset of the project's ~100 challenges,
  filtered to those a non-authenticated DAST agent should plausibly
  find.

### DVWA (`dvwa`)
- Local Docker at `low` security level.
- 10 ground-truth items: SQLi (classic + blind), XSS (reflected /
  stored / DOM), command injection, file inclusion, file upload,
  CSRF, brute-force.

### OWASP NodeGoat (`nodegoat`)
- Local Docker.
- 10 ground-truth items including Node-specific primitives
  (prototype pollution, SSJI, MongoDB injection).

### Acunetix testphp.vulnweb.com (`testphp-vulnweb`)
- Public PHP testbed.
- 8 ground-truth items: SQLi, XSS (reflected + stored), LFI,
  directory listing, server-info disclosure, missing headers.

## Reproducing

```bash
# 1. Stand up local targets
docker run -d -p 3000:3000 bkimminich/juice-shop
docker run -d -p 8080:80  vulnerables/web-dvwa  # then setup.php + Low security
# (and clone OWASP/NodeGoat if scoring nodegoat)

# 2. Run scans (UI / API). Each scan captures its scan_id.

# 3. Score
python bench/run.py --target altoro-mutual    --scan-id <UUID>
python bench/run.py --target juice-shop       --scan-id <UUID>
python bench/run.py --target dvwa             --scan-id <UUID>
python bench/run.py --target nodegoat         --scan-id <UUID>
python bench/run.py --target testphp-vulnweb  --scan-id <UUID>

# 4. Combined report
python bench/run.py --all
# → bench/results/BENCHMARKS.md
```

See `bench/README.md` for the full CLI surface (including `--run` for
auto-orchestration).
