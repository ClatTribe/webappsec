# Strix Orchestration Logic

How Strix turns a single user command (`strix --target …`) into a coordinated swarm of LLM agents that converges on a validated, deduplicated, fixable vulnerability report.

> **TL;DR.** The Python code only runs the agent loop. **The orchestration strategy lives in the prompts.** A root agent's job is *not* to test — it's to plan, decompose the target into vulnerability-class × component pairs, spawn one specialist sub-agent per pair, watch their reports come back, and converge. Each finding triggers a fixed pipeline — Discovery → Validation → Reporting → (white-box) Fixing — implemented as nested sub-agent spawns. The scan-mode skill (`quick`/`standard`/`deep`) controls how aggressive that fan-out is.

---

## Table of Contents

1. [The Two Layers](#1-the-two-layers)
2. [Where the Strategy Lives](#2-where-the-strategy-lives)
3. [The Root Agent's Mandate](#3-the-root-agents-mandate)
4. [Phase Model: Recon → Validate → Report → Fix](#4-phase-model-recon--validate--report--fix)
5. [The Vulnerability Pipeline](#5-the-vulnerability-pipeline)
6. [Black-Box vs White-Box Branching](#6-black-box-vs-white-box-branching)
7. [Scan-Mode Aggressiveness](#7-scan-mode-aggressiveness)
8. [How an Agent Decides to Spawn Another](#8-how-an-agent-decides-to-spawn-another)
9. [Convergence: How the Scan Ends](#9-convergence-how-the-scan-ends)
10. [Findings Deduplication](#10-findings-deduplication)
11. [Failure Modes & Escape Valves](#11-failure-modes--escape-valves)
12. [Worked Example](#12-worked-example)

---

## 1. The Two Layers

Strix's orchestration logic is split across **two layers**, both required to understand it:

| Layer | What it does | Where it lives |
|---|---|---|
| **Mechanism** | The `while True` agent loop, threading, message inboxes, tool dispatch, memory compression, sandbox routing | Python code under [strix/agents/](https://github.com/usestrix/strix/blob/main/strix/agents), [strix/tools/agents_graph/](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph), [strix/llm/](https://github.com/usestrix/strix/blob/main/strix/llm), [strix/runtime/](https://github.com/usestrix/strix/blob/main/strix/runtime) |
| **Strategy** | When to spawn an agent, what to delegate, when to validate, when to report, when to stop | Jinja system prompt + Markdown skills under [strix/agents/StrixAgent/system_prompt.jinja](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja), [strix/skills/coordination/](https://github.com/usestrix/strix/blob/main/strix/skills/coordination), [strix/skills/scan_modes/](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes), [strix/skills/vulnerabilities/](https://github.com/usestrix/strix/blob/main/strix/skills/vulnerabilities) |

The Python is intentionally policy-free: it parses tool calls and dispatches them. **The orchestration is the LLM following the prompt.** This document is mostly about the strategy layer — the mechanism is covered in [multiagent.md](multiagent.md).

---

## 2. Where the Strategy Lives

The system prompt rendered for any `StrixAgent` is composed at runtime from four sources, concatenated in this order:

1. **Base system prompt** — [`system_prompt.jinja`](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja). 800 + lines of policy: scope, refusal avoidance, multi-target handling, validation mandate, tool-call format, vulnerability priorities, and the multi-agent rules of engagement.
2. **Coordination skill** — `root_agent` for the root, plus `source_aware_whitebox` for white-box scans. Defines the orchestrator's role and the wiki-memory protocol.
3. **Scan-mode skill** — `quick.md`, `standard.md`, or `deep.md`. Defines phase counts, which scanners to run, when to skip vs. exhaustively test, and the size of the agent fan-out.
4. **Per-agent skills** — up to 5 vulnerability/framework/protocol/cloud/tooling playbooks chosen by the spawning parent (e.g. `sql_injection`, `authentication_jwt`, `nextjs`, `kubernetes`).

When a sub-agent is created, the parent picks **fewer** skills (often 1–3) so the child specializes. Each child agent therefore reads a different system prompt than its parent — the strategy narrows as you go down the tree.

---

## 3. The Root Agent's Mandate

The base prompt explicitly forbids the root from doing the work:

> **ROOT AGENT ROLE:**
> - The root agent's primary job is **orchestration, not hands-on testing**
> - The root agent should **coordinate strategy, delegate meaningful work, track progress, maintain todo lists, maintain notes, monitor subagent results, and decide next steps**
> - The root agent should **avoid spending its own iterations on detailed testing**, payload execution, or deep target-specific investigation when that work can be delegated to specialized subagents
> - Subagents should do the **substantive testing, validation, reporting, and fixing work**

Concretely, the root is supposed to:

1. **Build a target map** — every asset (code at `/workspace/<subdir>`, deployed URLs) and how they relate.
2. **Decompose by attack surface** — recon, auth, payments, admin, API, cron jobs, third-party integrations.
3. **Maintain shared state** — wiki notes (white-box), todo list, vulnerability registry.
4. **Decide what to spawn next** based on what's coming back from children.
5. **Aggregate at the end** — collect deduplicated findings, build the executive summary, call `finish_scan`.

The root almost never runs `terminal_execute`, `python_execute`, or `browser_*` itself. When you watch a real scan, almost every assistant turn from the root is one of: `create_agent`, `wait_for_message`, `view_agent_graph`, `update_note`, `update_todo`, `finish_scan`.

---

## 4. Phase Model: Recon → Validate → Report → Fix

Every scan-mode skill ([quick.md](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes/quick.md), [standard.md](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes/standard.md), [deep.md](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes/deep.md)) prescribes a phase sequence. The phases differ in depth but the structure is the same:

```
        ┌─────────────────────────────────────────────────────────────┐
Phase 1 │  RECON & UNDERSTANDING                                      │
        │  Black-box: subdomain enum, port scan, content discovery,   │
        │   tech fingerprint, role mapping, traffic capture           │
        │  White-box: AST/semgrep/gitleaks/trivy first-pass triage,   │
        │   route/sink mapping, auth model, wiki note creation        │
        └─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
Phase 2 │  BUSINESS LOGIC ANALYSIS                                    │
        │  Critical flows, role boundaries, data isolation rules,     │
        │  state transitions, trust boundaries                        │
        └─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
Phase 3 │  SYSTEMATIC ATTACK-SURFACE TESTING                          │
        │  Spawn one agent per (vulnerability class × component)      │
        │  Each child has 1–3 skills, ONE narrow job                  │
        │  Deep mode: also chain across HTTP smuggling, cache, CORS,  │
        │  prototype pollution, GraphQL, WebSocket                    │
        └─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
Phase 4 │  EXPLOITATION & CHAINING                                    │
        │  Each finding becomes a pivot — info leak → access bypass → │
        │  SSRF → internal access → privileged action                 │
        │  Spawn focused agents to continue chains                    │
        └─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
Phase 5 │  REPORTING (and Phase 6: FIXING in white-box)               │
        │  One reporting agent per validated finding                  │
        │  Reports go through dedupe before being committed           │
        │  White-box: a fixing agent per report writes the patch and  │
        │   re-validates by re-running the PoC                        │
        └─────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    Root: finish_scan with summary
```

Phase boundaries are advisory — agents can be spawned reactively at any phase ("CREATE AGENTS AS YOU GO — Don't create all agents at start, create them when you discover new attack surfaces").

---

## 5. The Vulnerability Pipeline

The most important orchestration pattern in Strix is the **per-finding pipeline**. Every potential vulnerability the system commits to investigating goes through a fixed chain of nested specialist agents:

### Black-box (3 agents per finding)

```
Discovery Agent
  · skills: e.g. sql_injection
  · job: confirm a suspicious behavior is worth chasing
       │
       │ if interesting → create_agent(...)
       ▼
Validation Agent
  · skills: same, plus business_logic if needed
  · job: build an actual exploit; reproduce reliably
       │
       │ if exploitable → create_agent(...)
       ▼
Reporting Agent
  · skills: same
  · job: ONE call to create_vulnerability_report with full PoC,
         CVSS vector, evidence, remediation guidance
       │
       │ agent_finish → completion report posted to parent's inbox
       ▼
   STOP
```

### White-box (4 agents per finding — adds a Fixing stage)

```
Discovery → Validation → Reporting → Fixing Agent
                                       · job: write the patch in /workspace,
                                         re-run the PoC against the patched build,
                                         confirm the vuln is closed
                                       · output: code diff that goes into the report
```

### Why pipelined and not monolithic?

The base prompt is explicit:

> **CRITICAL RULES**
> - NO FLAT STRUCTURES — Always create nested agent trees
> - VALIDATION IS MANDATORY — Never trust scanner output, always validate with PoCs
> - ONE AGENT = ONE TASK — Don't let agents do multiple unrelated jobs
> - **ONLY REPORTING AGENTS** can use `create_vulnerability_report` tool

The validation step exists specifically to drive false-positive rate down. The reporting step is gated: even if Discovery and Validation both believe in the finding, only an explicitly-spawned Reporting Agent can call `create_vulnerability_report`. This separation forces the model to commit a fresh agent (with fresh context) to writing the report, which in turn forces the writeup to stand on its own evidence.

### Skill scope rule

> Each agent must be **highly specialized; prefer 1–3 skills, up to 5** for complex contexts.

Bad delegation looks like one agent with `[sql_injection, xss, csrf, ssrf, authentication_jwt]`. Good delegation looks like five agents, one each, run in parallel.

---

## 6. Black-Box vs White-Box Branching

The same root-agent prompt handles both modes; the LLM picks the branch based on what's in the scan config and what's mounted at `/workspace/<subdir>`.

| Mode | Trigger | Recon Phase | Pipeline Length | Memory Protocol |
|---|---|---|---|---|
| **Black-box** | Targets are URLs/domains/IPs only | External enumeration, content discovery, traffic capture via Caido | 3-stage (Discovery → Validation → Reporting) | Per-agent only |
| **White-box** | At least one repository or local path target | Source-aware triage with `semgrep`, `ast-grep`, `tree-sitter`, `gitleaks`, `trufflehog`, `trivy fs`, plus dynamic run of the app | 4-stage (adds Fixing) | Shared **wiki notes** keyed by repo |
| **Combined** | Both source and deployed URLs | Static + dynamic in parallel; static findings prioritize live testing, dynamic anomalies prioritize code review | 4-stage | Wiki notes |

The white-box-specific [`source_aware_whitebox.md`](https://github.com/usestrix/strix/blob/main/strix/skills/coordination/source_aware_whitebox.md) skill is auto-loaded for any agent created when `is_whitebox=True` (see `_get_skills_to_load` in [strix/llm/llm.py](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py)). It mandates:

- Build `sg-targets.txt` from `semgrep.json` scope before structural pass.
- Run **all four** source-aware passes per repo: semgrep, AST, secrets, trivy. If any are skipped, log the reason in the wiki.
- Each child source-focused agent reads the wiki note **before** working and appends a delta **before** `agent_finish`.
- "**Static findings are hypotheses until validated.** Dynamic exploitation evidence is still required before vulnerability reporting."

---

## 7. Scan-Mode Aggressiveness

The scan-mode skill controls **how big the swarm grows** and **how thoroughly each phase runs**.

| Behavior | `quick` | `standard` | `deep` |
|---|---|---|---|
| Default reasoning effort | `medium` | `high` | `high` |
| Recon depth | Skip subdomain enum / dir-bruteforce; focus on changed files (PR diff scope) | Crawl thoroughly, fingerprint, capture | Exhaustive subdomain enum, full port scan, multiple wordlists, JS analysis |
| Vulnerability target list | 6 high-impact only (Auth bypass, IDOR, RCE, SQLi, SSRF, secrets) | All standard top 10 | Top 10 + smuggling, cache poisoning, prototype pollution, GraphQL, WebSocket |
| Sub-agent fan-out | "Create subagents only for **parallel high-priority** tasks" | "Spawn focused subagents for different areas" | "Massive parallel swarm covering every angle" — agent per (vuln × component × feature) |
| Chaining | One pivot per finding to demonstrate severity | "Ask: if I can do X, what does that enable next?" | Until reaching maximum privilege / data exposure / control |
| Skipped categories | Theoretical issues without working PoC; low-severity info disclosure | Nothing systemically skipped | Nothing skipped |
| Persistence | "Pivot if not yielding quickly" | "Methodical and systematic. Document as you go." | "Real vulnerabilities take 2000+ steps minimum. Bug bounty hunters spend DAYS — so should you." |

So the same target can produce a 5-agent run on `quick` and a 50-agent run on `deep`, with the same code path orchestrating both — only the prompt differs.

---

## 8. How an Agent Decides to Spawn Another

The base prompt encodes the spawn-or-not decision as nine numbered rules:

1. **CREATE AGENTS SELECTIVELY** — Spawn when delegation materially improves parallelism, specialization, coverage, or independent validation.
2. **BLACK-BOX:** Discovery → Validation → Reporting (3 agents per vulnerability).
3. **WHITE-BOX:** Discovery → Validation → Reporting → Fixing (4 agents per vulnerability).
4. **MULTIPLE VULNS = MULTIPLE CHAINS** — Each finding gets its own pipeline.
5. **CREATE AGENTS AS YOU GO** — Reactive, not all-at-start.
6. **ONE JOB PER AGENT** — One specific task.
7. **SCALE AGENT COUNT TO SCOPE** — Correlate count with target size.
8. **CHILDREN ARE MEANINGFUL SUBTASKS** — Don't create unrelated children.
9. **UNIQUENESS** — No two agents with the same task.

Every `create_agent` call inside the running system is the model applying these rules. There is **no Python-side check** that a child's task differs from its sibling's, no enforcement that skills are appropriate, no quota on agent count. The prompt is the policy.

The base prompt also tells the agent what to load **before** spawning:

> Use the `load_skill` tool when you need exact vulnerability-specific, protocol-specific, or tool-specific guidance before acting. Prefer loading a relevant skill before guessing payloads, workflows, or tool syntax from memory.

So the typical pattern from a discovery sub-agent that finds something interesting is:

```
1. think          (reason about what was seen)
2. load_skill     (e.g. business_logic)
3. terminal_execute / python_execute   (validate hypothesis)
4. create_agent   (delegate validation to a fresh specialist with a clean context)
```

---

## 9. Convergence: How the Scan Ends

The scan terminates exactly when the **root** calls `finish_scan`. Sub-agents calling `agent_finish` only close themselves and post a completion report up the tree.

The base prompt's exit conditions for the root are:

- All planned agents have reported (success or failure).
- All findings have been validated and reported.
- All fixes (white-box) have been applied and re-validated.
- The highest-value in-scope paths have been properly assessed.

Mechanism:

- The root's loop calls `wait_for_message` whenever it has nothing to do, putting it in `waiting_for_input` status with a 300 s (interactive) or 600 s (non-interactive) timeout. New messages from children resume it instantly.
- The root drains its inbox each iteration, reads `<agent_completion_report>` blocks, decides whether to spawn more agents or to converge.
- When everything's settled, the root produces an **executive summary** and calls `finish_scan`.

`finish_scan` returns a result with `scan_completed: True`, which the agent loop sees as `should_agent_finish=True` and exits. `main.py` then writes results to `strix_runs/<run-name>/` and prints the completion panel. Headless exit code is `2` if any vulnerabilities were reported, `0` otherwise.

If the root never calls `finish_scan`, the loop terminates anyway when:

- Iteration count hits `max_iterations = 300`. A two-stage warning fires at 85 % and at `max - 3`.
- The user hits Ctrl-C / sends `stop_agent`.
- An unrecoverable LLM or sandbox failure occurs.

---

## 10. Findings Deduplication

Multiple agents pursuing related vulnerability classes will surface the same bug from different angles (e.g. an auth agent and a session agent both finding the same logout flaw). The orchestration handles this with a **single-source dedupe at the reporting boundary**:

[`strix/llm/dedupe.py`](https://github.com/usestrix/strix/blob/main/strix/llm/dedupe.py) runs an LLM judge on every `create_vulnerability_report` call. The judge sees:
- The candidate report.
- All previously committed reports for this scan.

Same root cause + same affected component + same exploitation method ⇒ duplicate, candidate is rejected. Different endpoint or different parameter ⇒ not a duplicate, both are kept.

The base prompt instructs:

> If `create_vulnerability_report` rejects your report as a duplicate, **DO NOT attempt to re-submit**. Accept the rejection and move on. The vulnerability has already been reported by another agent.

So redundant pipelines self-prune at the reporting stage rather than producing noisy duplicate findings.

---

## 11. Failure Modes & Escape Valves

### Persistence mandate

The prompt repeatedly drills the model on not giving up:

> **PERSISTENCE IS MANDATORY:**
> - Real vulnerabilities take TIME — expect to need 2000+ steps minimum
> - NEVER give up early — attackers spend weeks on single targets
> - If one approach fails, try 10 more approaches
> - Bug bounty hunters spend DAYS on single targets — so should you

This is the prompt's main defense against the LLM's natural tendency to declare "no findings" too early.

### Iteration warnings

Built into the agent loop, not the prompt:

- At **85 %** of `max_iterations` (default 300, so iter ≥ 255): "approaching limit — prioritize finishing".
- At **`max - 3`** (iter = 297): "CRITICAL: 3 iterations left. Your next message MUST be a `finish_scan`/`agent_finish` tool call."

This prevents an agent from running out of budget mid-action and leaving the scan in an undefined state.

### Empty-message correction

If an agent emits text with no tool call, the base prompt says:

> A message WITHOUT a tool call IMMEDIATELY STOPS your entire execution and waits for user input.

Combined with the loop's empty-content corrective injection, this stops the model from filling iterations with planning prose.

### "No findings" outcomes are valid

The prompt explicitly normalizes negative results:

> **REALISTIC TESTING OUTCOMES:**
> - **No Findings:** Agent completes testing but finds no vulnerabilities
> - **Validation Failed:** Initial finding was false positive, validation agent confirms it's not exploitable
> - **Valid Vulnerability:** Validation succeeds, spawns reporting agent and then fixing agent

So a Discovery → Validation pipeline that ends in "false positive" is a successful run, not a failed one.

### Stuck agent

Any agent can be force-stopped via `stop_agent(agent_id)`. The TUI exposes this; the prompt mentions it as a tool the root may use to terminate sub-agents that are no longer relevant.

---

## 12. Worked Example

Take `strix --target ./e-commerce-app --scan-mode deep` (white-box).

**T = 0** Root spawns. Skills: `root_agent`, `scan_modes/deep`, `coordination/source_aware_whitebox`, `custom/source_aware_sast`. The system_prompt_context tells it `/workspace/e-commerce-app` is in-scope.

**T = 1–10** Root maps the repo. Calls `update_note(category="wiki")` to create the repo wiki. Runs (or delegates) the four mandated source passes — `semgrep`, `sg`, `gitleaks`, `trivy fs`. Wiki gets a static-scanner-summary section.

**T = 11** Root spawns parallel **component agents**:
- `Auth Component Agent` — skills `[authentication_jwt, business_logic]`
- `Payment Component Agent` — skills `[business_logic, race_conditions]`
- `Admin Panel Agent` — skills `[broken_function_level_authorization, idor]`
- `User Profile Agent` — skills `[idor, mass_assignment]`
- `Search Agent` — skills `[sql_injection, xss]`

Five threads start, each with its own asyncio loop. Each child reads the shared wiki note, gets `<agent_delegation>` + scope, begins work in its own tmux pane / IPython kernel / browser tab.

**T = 30 (Auth Component Agent)** Spots a JWT signed with HS256 using a guessable secret. **Spawns a child:** `JWT-Secret-Validation Agent` with skill `authentication_jwt`. Adds a wiki delta noting "auth uses HS256, secret may be guessable".

**T = 35 (JWT-Secret-Validation Agent)** Brute-forces the secret with `jwt_tool` in a terminal pane. Finds it. Confirms a user's token can be forged. **Spawns a child:** `JWT-Reporting Agent` with skill `authentication_jwt`.

**T = 38 (JWT-Reporting Agent)** Calls `create_vulnerability_report` with full CVSS vector, PoC token, and remediation guidance. Dedupe accepts (no prior JWT report). `agent_finish(success=True)` posts the completion report up the chain.

**T = 39 (JWT-Validation Agent)** Receives the completion report from its reporting child. Since this is white-box, **spawns a child:** `JWT-Fixing Agent` with skill `authentication_jwt`.

**T = 50 (JWT-Fixing Agent)** Edits the auth module to use RS256 + a generated keypair, runs the unit tests, re-runs the PoC, confirms the fix. Appends the diff to the report. `agent_finish`.

**T = 60** Meanwhile, `Search Agent` has spawned its own `SQLi-Validation Agent` → `SQLi-Reporting Agent` → `SQLi-Fixing Agent` pipeline. `Payment Component Agent` discovers a TOCTOU and spawns its own pipeline. `Admin Panel Agent` finds nothing exploitable and `agent_finish(success=True, findings=[])` — the prompt says that's a valid outcome.

**T = 200** All component agents have called `agent_finish`. Root's inbox is full of completion reports. Root drains them, queries the vulnerability registry, sees 4 validated + fixed findings. Calls `view_agent_graph` once to confirm everyone has terminated.

**T = 205** Root composes the executive summary, includes the wiki snapshot, and calls `finish_scan`. The agent loop returns. `main.py` writes `strix_runs/e-commerce-app_a1b2/` with transcripts, vuln reports, code diffs, run metadata. TUI renders the completion panel. `DockerRuntime.cleanup()` removes the container. Headless exit code: `2` (vulnerabilities found).

**Total agents: ~25.** Validated findings: 4. Re-validated fixes: 4. Token cost: rolled-up sum from `_completed_agent_llm_totals` shown in the final panel.

The root agent spent its iterations planning, spawning, draining its inbox, and updating the wiki — almost no payload execution. That separation between **orchestrator** and **specialists** is the operating principle.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — high-level architecture.
- [feature.md](feature.md) — every shipped feature in detail.
- [multiagent.md](multiagent.md) — the *mechanism* of multi-agent execution (loops, threads, memory, tools).
- [ToolCall.md](ToolCall.md) — how tool invocations are dispatched.
- [Isolation.md](Isolation.md) — the boundaries between agents and between scans.
- [strix/agents/StrixAgent/system_prompt.jinja](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja) — the actual base prompt.
- [strix/skills/coordination/root_agent.md](https://github.com/usestrix/strix/blob/main/strix/skills/coordination/root_agent.md) — the orchestration skill.
- [strix/skills/scan_modes/](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes) — quick / standard / deep playbooks.
