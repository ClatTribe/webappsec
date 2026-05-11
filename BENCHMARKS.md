# TensorShield benchmarks

How TensorShield performs against publicly-known vulnerable web apps.
Methodology + ground-truth in [`bench/`](bench/).

## Latest results

| Target | Ground truth | Findings | TP | FN | Extras | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| altoro-mutual (run 4 · engine `4f3f93c` + Dockerfile fix · Gemini Flash) | 15 | **3** | **2** | 13 | 1 | **67%** | **13%** | **22%** |

**First non-zero recall.** Took 3 attempts to get here — each surfaced a real bug:

- Run 1 (May 6) — engine emission starvation, fixed upstream as strix#147 → 0%
- Run 2 (this session, take 1) — `No module named 'strix.sca'` on every tool call → 0%
- Run 3 (this session, take 2, one-line sca-only Dockerfile fix) — `No module named 'strix.threat_intel'` → 0%
- Run 4 (this session, take 3, **wholesale `COPY strix/`**) — **3 findings**, $1.36, 25 min

The sandbox image was cherry-picking strix subdirectories into `/app/strix/`. As the strix package grew (Phase 6 SCA, Phase 9 threat-intel, Phase 11 IaC, etc.), every new subdir silently broke the sandbox because Python found `/app/strix/<subdir>/` empty before falling back to `.venv`. **Fix upstream: replace 7 cherry-pick COPYs with `COPY strix/ /app/strix/`.** Filed as a PR against ClatTribe/strix.

### Run 4 — what got caught

| Severity | Title | Endpoint | Match |
|---|---|---|---|
| high | Business Logic Flaw: Negative Amount Transfer | `/api/transfer` | **Extra** (real Altoro vuln, not in our 15-item ground truth) |
| medium | Reflected XSS in Search Query Parameter | — | ✓ matches `altoro-xss-reflected` |
| medium | Insecure Direct Object Reference (IDOR) in Account / Transaction APIs | `/api/account/{accountNo}` | ✓ matches `altoro-param-tampering` (CWE-639) |

The "extra" — negative-amount-transfer business-logic flaw — is a documented Altoro Mutual issue our ground truth list didn't include. By the strict scoring rule it counts against precision, but it's a real positive. The ground truth deserves a refresh.

### Still uncovered (13 of 15)

SQLi at `/bank/login.aspx` + `/search.aspx`, stored XSS in feedback, LFI via `content=`, default creds, missing headers (X-Frame-Options, CSP), HTTP TRACE, info-disclosure (`/comment.txt`, `/robots.txt`), server banner, CSRF on money-transfer, plaintext HTTP for banking. The engine ran 5 agents in this scan but didn't dispatch specialists for several categories. Probably worth running again with `STRIX_LLM=gemini/gemini-2.5-pro` to compare — Flash may be selecting fewer specialist branches than Pro would.

### History of attempts (kept for the receipts)

| Run | Engine | Sandbox bug | Model | Cost | Duration | Findings | Recall |
|---|---|---|---|---:|---:|---:|---:|
| 1 | `3b48809` | none (pre-strix#147) | Pro | $2.61 (capped) | 45 min | 0 | 0% |
| 2 | `4f3f93c` | `strix.sca` missing | Flash | $0.10 | 66 s | 0 | 0% |
| 3 | `4f3f93c` + 1-line fix | `strix.threat_intel` missing | Flash | $0.09 | 57 s | 0 | 0% |
| **4** | **`4f3f93c` + wholesale COPY** | **none** | **Flash** | **$1.36** | **25 min** | **3** | **13%** |

### How we found the Dockerfile bug

Runs 2 and 3 looked identical on the surface — both exited cleanly in <90s with 0 findings and "scan_completed" status. That looked like a model-quality issue (Flash exiting too eagerly) until inspection of `events.jsonl` showed every `tool.execution.updated` returning:

> `Sandbox execution error: Tool execution error: No module named 'strix.sca'`

The lead agent dispatched tools correctly. The sandbox container didn't have the source. Looking at `containers/Dockerfile`:

```Dockerfile
COPY strix/__init__.py strix/
COPY strix/config/ /app/strix/config/
COPY strix/utils/ /app/strix/utils/
COPY strix/telemetry/ /app/strix/telemetry/
COPY strix/runtime/tool_server.py strix/runtime/__init__.py strix/runtime/runtime.py /app/strix/runtime/
COPY strix/tools/ /app/strix/tools/
```

Just 7 subdirs / files — **none of the new ones**: agents, baselines, compliance, finding_chains, iac, llm, prompts, sast, **sca**, skills, **threat_intel**. `uv sync` installs the package into `.venv/lib/.../site-packages/strix/` but `/app/strix/` is earlier on `sys.path`, so Python finds the half-populated tree first.

Fixed by replacing the cherry-picks with `COPY strix/ /app/strix/`. PR filed against ClatTribe/strix.

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
