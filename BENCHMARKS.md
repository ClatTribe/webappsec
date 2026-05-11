# TensorShield benchmarks

How TensorShield performs against publicly-known vulnerable web apps.
Methodology + ground-truth in [`bench/`](bench/).

## Latest results

| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| altoro-mutual (run 2 · engine `4f3f93c` · Gemini Flash) | 15 | **0** | 0 | 15 | 0 | 0% | 0% | 0% |

Still 0% — but the failure mode is **completely different** from the first run. The emission-starvation bug is fixed; a new under-scan behaviour took its place.

### Two runs, two different reasons for 0%

| | Run 1 (May 6) | Run 2 (May 11, **this run**) |
|---|---|---|
| Engine commit | `3b48809` (pre-fix) | `4f3f93c` (post emission-fix [#147](https://github.com/ClatTribe/strix/pull/147)) |
| Model | `gemini-2.5-pro` | `gemini-2.5-flash` |
| Agents spawned | 8 specialists | 1 lead only |
| Tool executions | 38 browser + 20 terminal | 13 tool calls |
| Duration | 45 min | 66 sec |
| Cost | $2.61 (hit cap) | $0.10 |
| Exit code | 3 (budget exceeded) | 0 (clean) |
| `coverage.json.status` | `incomplete`, gaps={csrf,idor,open_redirect,sqli,ssrf,xss} | `incomplete`, gaps={csrf,idor,open_redirect,sqli,ssrf,xss} |
| Root cause | Agents probed extensively but never converted findings into structured emissions before budget fired | Lead agent ran 12 LLM calls, decided the run was "done" with `scan_completed: true`, never dispatched specialists |

Run 1 was the [emission-starvation incident](https://github.com/ClatTribe/strix/blob/main/docs/incidents/2026-05-06-finding-emission-starvation.md) — finding-evidence-was-found-but-not-emitted.

Run 2 is a new gap: **the lead agent under-dispatched.** With Gemini Flash as the reasoning model, the lead executed ~12 reconnaissance steps against `http://demo.testfire.net`, then emitted `finding.reviewed { scan_completed: true, vulnerability_count: 0 }` and exited — without ever spawning the planned XSS / SQLi / CSRF / IDOR / SSRF / open-redirect specialists. The `run.test_plan` event lists those categories as `planned`; `run.coverage_gap` at scan-end lists them all as unfulfilled.

This is exactly the harness's job: surface that fresh-engine + Flash, on a textbook target with `gemini-2.5-flash`, didn't scan deeply enough to find anything. **Worth filing upstream** as a "lead-only-dispatch-when-Flash-is-the-reasoning-model" gap — Flash is the cost-optimal default per our cost-reduction PR (#94), but if it can't dispatch specialists for DAST-rich targets, it's a recall-vs-cost trade-off the wrapper needs to know about.

### Reproducing run 2

```bash
# Sandbox image (HEAD 4f3f93c)
cd /path/to/strix && DOCKER_BUILDKIT=1 docker build \
  -f containers/Dockerfile -t strix-sandbox:fork-latest .

# Worker .env: STRIX_LLM=gemini/gemini-2.5-flash, LLM_API_KEY=<your-gemini-key>
cd webapp/worker && source .venv/bin/activate && set -a; source .env; set +a
python -m strix_worker &

# Create the scan via the atomic RPC (so scan_targets lands before scan_queued NOTIFY)
SQL='select public.create_scan_with_targets(
  ''<org_id>''::uuid, ''bench: altoro fresh engine'', ''standard'', ''auto'',
  null, null, ''<target_id>''::uuid,
  ''[{"type":"web_application","value":"http://demo.testfire.net","workspace_subdir":"target_1"}]''::jsonb,
  array[]::uuid[], false, null, 2.50, null, null);'
docker exec supabase_db_strix-webapp psql -U postgres -d postgres -c "$SQL"

# Score
export BENCH_SUPABASE_URL=... BENCH_SUPABASE_SERVICE_ROLE_KEY=...
python bench/run.py --target altoro-mutual --scan-id <UUID>
```

### What to try next to get a non-zero number

- Re-run with `STRIX_LLM=gemini/gemini-2.5-pro` (heavier reasoning may dispatch specialists more aggressively).
- Re-run with `-m deep` instead of `standard`.
- Re-run with `STRIX_AGENT_ARCHITECTURE` unset / set to the old multi-agent default (if env-overridable in `4f3f93c`).
- Re-run with a longer `--max-cost` (e.g. $5) to give the lead more headroom before deciding it's "done".

## Other targets (pending first run)

| Target | Hosting | Ground truth | Status |
|---|---|---:|---|
| `altoro-mutual` | Public (`demo.testfire.net`) | 15 | 2 runs, both 0% recall, different failure modes (see above) |
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
