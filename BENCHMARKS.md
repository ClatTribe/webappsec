# TensorShield benchmarks

How TensorShield performs against publicly-known vulnerable web apps.
Methodology + ground-truth in [`bench/`](bench/).

## Latest results

_Run on the only Altoro Mutual scan we have on record (engine commit `3b48809`, `gemini/gemini-2.5-pro`, standard mode, $2.50 budget cap, single-lead architecture)._

| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| altoro-mutual | 15 | **0** | 0 | 15 | 0 | 0% | 0% | 0% |

### What this number means right now

The engine ran 8 specialist sub-agents for 45 minutes, ran 38 browser actions and 20 terminal commands, **and never emitted a `finding.created` event** before the budget cap fired. This is the [`finding-emission-starvation` incident](https://github.com/ClatTribe/strix/blob/main/docs/incidents/2026-05-06-finding-emission-starvation.md) we filed upstream as [strix#147](https://github.com/ClatTribe/strix/pull/147). Root cause: agents were thinking about evidence but not converting that thinking into structured `finding.created` emissions; budget exhausted before any agent shipped an emission.

The findings ARE there — the agent narrated SQL injection investigations against `/bank/login.aspx` and `/search.aspx`, missing security headers, default credentials. They just never reached the wrapper's table.

This is exactly the failure mode a benchmark harness is meant to surface. **Engine fix shipped, but no rerun has been logged yet** — this number will move once a fresh scan runs under the fixed engine.

### How to refresh this

```bash
# 1. Run a fresh scan against demo.testfire.net from the TensorShield UI
#    (org workspace → register asset → scan)
# 2. Get the scan_id from the URL or the scans table
# 3. Score it:

export BENCH_SUPABASE_URL=...
export BENCH_SUPABASE_SERVICE_ROLE_KEY=...

python bench/run.py --target altoro-mutual --scan-id <UUID>

# 4. Copy bench/results/BENCHMARKS.md content into this file.
```

## Other targets (pending first run)

| Target | Hosting | Ground truth | Status |
|---|---|---:|---|
| `altoro-mutual` | Public (`demo.testfire.net`) | 15 | One historical scan, recall 0% (engine bug — fix shipped) |
| `juice-shop` | Local Docker | 12 | Not yet scanned |
| `dvwa` | Local Docker | 10 | Not yet scanned |
| `nodegoat` | Local Docker | 10 | Not yet scanned |
| `testphp-vulnweb` | Public | 8 | Not yet scanned |

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
3. **all** title keywords present in the finding's title / description.

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

### Sanity check

The scorer was verified against synthetic data (8 representative
findings against the 15 Altoro ground-truth entries) → **89% precision,
53% recall, 67% F1** — matching the expected math. The 0% above is
the scorer correctly reporting that no actual findings landed.

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

See [`bench/README.md`](bench/README.md) for the full CLI surface (including `--run` for
auto-orchestration).
