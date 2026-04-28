# Upstream tools wishlist

Feature requests we'd send to [`usestrix/strix`](https://github.com/usestrix/strix) (and any other tools we wrap) to make the integration boundary cleaner. Each item is something we work around today — the workaround is fine, the upstream change would be cleaner.

This is a **wishlist**, not a contract. We don't block on any of these. We just want a single place to track what would let us delete worker-side glue.

Read this alongside [`Architecture.md`](Architecture.md) (how the worker drives Strix) and [`roadmap.md`](roadmap.md) (what we're building on top).

---

## Strix

### Priority 0 — make the scan readable to a human

The scan UI today shows technical exhaust (agent IDs, tool-call counts, raw URLs) but nothing that tells a developer or product owner *what was actually checked*. We tried to render this from `events.jsonl` and the answer was effectively "an agent named `WorkerScanProcessorAgent` ran 13 tool calls" — true, but useless. These are the upstream changes that would let us replace that with a real security report.

| | Item | Why we want it | What we do today | Proposed shape |
|---|---|---|---|---|
| 🔴 | **Test plan event at scan start** | A reader needs to know what *categories* the scan intends to cover before it starts. "We're testing for SQL injection on /search and SSRF on /api/scans" is the answer to the question "what is this scan doing?" | We echo the user's free-text instruction back. It says nothing about coverage. | Emit `run.test_plan` after `run.configured` with `{categories: ["sqli", "ssrf", "auth"], targets: [{value, planned_checks: [...]}]}`. Strix's planner already decomposes the instruction into sub-goals — surface them. |
| 🔴 | **Semantic checkpoint events** (`check.started` / `check.completed`) | Tells the user what was *attempted*, not just what was found. A scan that tested 8 attack classes and found 2 vulns is more reassuring than a scan that found 2 vulns with no idea what else was tried. | Nothing — we can only show the findings (one side of the ledger). | `check.started {category: "sqli", surface: "/search?q=", method: "GET"}` and `check.completed {category, surface, result: "vulnerable" \| "not_vulnerable" \| "inconclusive", confidence: 0.0-1.0}`. Worker pipes these into `scan_events`; UI renders coverage. |
| 🔴 | **Findings tagged with semantic category, not just CWE** | We bucket findings into 14 categories (SQLi / SSRF / IDOR / etc.) for the UI. Today we infer the category from CWE + title keywords — which works, but our category list is private and may drift from Strix's mental model. | `categoriseFinding` in [`findings-summary.tsx`](webapp/frontend/components/scan/findings-summary.tsx) does ad-hoc CWE+keyword bucketing. | Add `category` (string) and `category_label` (human-readable) to the report dict in `add_vulnerability_report`. Pre-defined enum: `sqli`, `xss`, `cmd_injection`, `ssrf`, `auth`, `authz`, `idor`, `crypto`, `info_disclosure`, `csrf`, `path_traversal`, `misconfig`, `race_condition`, `open_redirect`, `other`. |
| 🟠 | **Plain-language `run.summary` event at scan end** | A one-paragraph English summary the user can scan in 10 seconds. The LLM already wrote one to `penetration_test_report.md` — surface it as an event, not just a markdown blob we have to re-parse. | Worker stores the markdown report as an artifact. UI doesn't read it. | `run.summary {text: "Scanned login + 12 API endpoints. Found 1 critical SSRF, 2 medium misconfigurations. Authentication and authorization checks passed.", duration_seconds, tested_categories, ...}`. |
| 🟠 | **Per-agent task category tag** | Same idea but per agent. When Strix spawns sub-agents (`auth-attacker`, `ssrf-scanner`), each should declare what it's responsible for — not just a free-text task. | We render `agent.created.payload.task` verbatim, which is just the user's instruction echoed back. | Add `category` (one of the same enum) to `agent.created.payload`. Sub-agents that probe a single attack class should always set this. |

---

### Priority 1 — kill the stdout-scraping path

| | Item | Why we want it | What we do today | Proposed shape |
|---|---|---|---|---|
| 🔴 | **Token / cost stats in `events.jsonl`** | Required for cost caps, billing, plan enforcement. Without persistence in the structured stream, every consumer has to scrape stdout. | We regex-parse the rendered stats panel from stdout in [`StrixStats`](webapp/worker/src/strix_worker/runner.py). Numbers come humanised (`2.6M`, `14.4K`) — we lose ~3 digits of precision on every count above 1M. | Emit `usage.updated` events as agents finish (or include `total` + per-agent breakdown in the existing `run.completed` payload). Keep the rendered panel for the CLI; just also write the raw ints to `events.jsonl`. |
| 🔴 | **Live event stream**, not just on disk at exit | A 30-min scan with no UI feedback feels broken. Today the structured agent graph only appears after Strix exits. | We tail stdout for "log" events (coarse, unstructured) and only ingest `events.jsonl` after `proc.wait()`. | Either (a) tail-friendly `events.jsonl` writes (we tail the file) — basically already true, just needs a documented contract that lines are flushed; or (b) `--events-stdout` mode that interleaves NDJSON event records with normal stdout. We'll take either. |
| 🔴 | **Per-event token usage on `chat.message` / new `llm.request.completed`** | Lets us enforce per-scan cost caps mid-flight instead of post-mortem. Today a runaway can burn the whole budget before we see the totals. | Nothing — we only know the cost when Strix exits. | Attach `{input_tokens, output_tokens, cached_tokens, cost, model}` to each LLM round-trip event. |

### Priority 2 — make findings parseable as data

| | Item | Why we want it | What we do today | Proposed shape |
|---|---|---|---|---|
| 🟠 | **`vulnerabilities.json`** alongside the markdown | Markdown is for humans. We need structured data for the DB row. | We parse `**Field:** value` lines out of `vuln-NNNN.md` in [`_ingest_finding`](webapp/worker/src/strix_worker/runner.py) — a literal-prefix regex that's already silently broken once (the severity parser). | Write `vulnerabilities.json` with the full `report` dict already in `add_vulnerability_report`. Same data, no parser. |
| 🟠 | **Stable severity casing across surfaces** | Today: markdown uppercases, event payloads lowercase, CSV uppercases. We `.lower()` everything before storing. | `(sev_raw or "info").lower()` defensively. | Pick lowercase everywhere in machine-readable outputs (markdown can stay uppercase for display). |
| 🟡 | **Run-level metadata file** (`run_meta.json`) | Reconstructing the scan config from scattered sources is fragile. | We pull model from env, targets from the scan row, mode from CLI args. | Write `run_meta.json` at run start: `run_id`, `run_name`, `start_time`, `model_name`, `targets`, `mode`, `max_iterations`, `scope_mode`. |
| 🟡 | **Findings deduplication hint** | Same finding surfaced by multiple agents shows up N times; we fingerprint on our side. | [`_compute_fingerprint`](webapp/worker/src/strix_worker/runner.py) hashes CWE + endpoint + title prefix. | Strix could attach a `dedup_key` to the report dict. We'd still hash defensively (LLMs reword), but a strong signal helps. |

### Priority 3 — operational hardening

| | Item | Why we want it | What we do today | Proposed shape |
|---|---|---|---|---|
| 🟠 | **Built-in cost / token / iteration caps with self-exit** | Belt-and-braces for free-tier abuse and runaways. Right now we plan to cap externally; defence-in-depth would cap inside the agent loop too. | Nothing — we trust the model to stop on `--max-iterations`. | `--max-cost 5.00`, `--max-input-tokens 1000000`. Strix exits cleanly with a documented exit code (e.g. 3 = budget exceeded) and a `run.terminated` event. |
| 🟠 | **Heartbeat events** (`run.heartbeat` every ~60s with `last_activity_at`) | Detect stuck scans (Gemini Pro rate-limit hangs were our motivating incident). Roadmap §1's "stuck-scan recovery" needs a signal to act on. | We poll our own `scans.last_heartbeat_at` and there is no signal yet. | Periodic event with `{seconds_idle, last_tool_call, last_llm_request_at}`. |
| 🟠 | **Clean SIGTERM handling** | Roadmap §1 needs a scan-cancel button. Today `kill -TERM` may leave half-written `events.jsonl` and orphan the sandbox. | Worker doesn't expose cancel yet, partly because of this. | On SIGTERM: cancel in-flight LLM call, flush `events.jsonl`, emit `run.cancelled`, tear down sandbox, exit 130. Document the contract. |
| 🟡 | **Explicit exit-code contract** | Currently the worker treats `{0, 2}` as success per a code comment we read once. | `if exit_code in (0, 2)` in [`runner.py`](webapp/worker/src/strix_worker/runner.py:82). | Document: `0` = clean, no findings; `2` = clean, with findings; `1` = config/setup error; `3` = budget exceeded; `130` = SIGINT; `143` = SIGTERM. Worker can act on each. |

### Priority 4 — nice-to-haves

| | Item | Why | Shape |
|---|---|---|---|
| 🟢 | **`run.configured` event with the resolved config** | Audit / debugging. We want to know exactly what model + flags ran. | Single event after CLI arg parsing with the full effective config. |
| 🟢 | **`target.started` / `target.completed` events** | UI shows "Agent X on target Y" today via heuristics. Multi-target scans have no clean per-target progress. | Per-target events with the target value. |
| 🟢 | **Pluggable triage hook** (`--on-finding-script`) | We do RL-driven triage on our side. A pre-finalisation hook would let us enrich/dismiss in-line. | Strix calls the script with the finding JSON on stdin; if it exits with `dismiss`, the finding doesn't land in `vulnerabilities/`. |
| 🟢 | **Agent / target context on every `tool.execution.*` event** | We display `agent_name` and `target` per tool call; today we join across multiple events. | Add `agent_name`, `target` directly to `tool.execution.started` / `.updated`. |
| 🟢 | **`--quiet` mode that still emits `events.jsonl`** | Strix's stdout output is for the CLI user. Server use has no terminal. | Suppress Rich panels, keep file output untouched. (We work around with non-TTY detection but Rich still emits ANSI in some cases.) |

---

## Other tools we wrap

Nothing yet — Strix is the only embedded engine right now. When we add additional scanners or LLM providers, this section will track the same kind of asks against them.

---

## Process

When you discover a new pain point at the Strix boundary while working on the worker:

1. Add it here under the right priority bucket.
2. Link the worker file/line where the workaround lives, so when the upstream feature lands we know what to delete.
3. Open an issue at [`usestrix/strix`](https://github.com/usestrix/strix/issues) referencing this file.

When upstream lands a feature on this list:

1. Strike through the row.
2. Open a follow-up issue here to delete the worker-side workaround.
