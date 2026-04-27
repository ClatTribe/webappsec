# Strix — Feature Reference

This document is a deep-dive on every feature that ships with Strix. For a quickstart see the [Strix README](https://github.com/usestrix/strix#readme); for external-facing documentation see [docs.strix.ai](https://docs.strix.ai).

Each section lists the user-visible behavior, how it's implemented, and the files you can read to learn more.

---

## Table of Contents

1. [CLI Entrypoint & Argument Parsing](#1-cli-entrypoint--argument-parsing)
2. [Interactive TUI](#2-interactive-tui)
3. [Headless / Non-Interactive Mode](#3-headless--non-interactive-mode)
4. [Multi-Target Scanning](#4-multi-target-scanning)
5. [Target Type Inference](#5-target-type-inference)
6. [Scan Modes](#6-scan-modes)
7. [Scope Modes & PR Diff Scoping](#7-scope-modes--pr-diff-scoping)
8. [Custom Instructions](#8-custom-instructions)
9. [Configuration System & Persistence](#9-configuration-system--persistence)
10. [LLM Provider Abstraction](#10-llm-provider-abstraction)
11. [Reasoning Effort Control](#11-reasoning-effort-control)
12. [Memory Compression](#12-memory-compression)
13. [Docker Sandbox Runtime](#13-docker-sandbox-runtime)
14. [Tool Registry](#14-tool-registry)
15. [Multi-Agent Graph](#15-multi-agent-graph)
16. [Inter-Agent Messaging](#16-inter-agent-messaging)
17. [HTTP Proxy (Caido)](#17-http-proxy-caido)
18. [Browser Automation](#18-browser-automation)
19. [Terminal Sessions](#19-terminal-sessions)
20. [Python Runtime](#20-python-runtime)
21. [File Editing](#21-file-editing)
22. [Notes & TODO Lists](#22-notes--todo-lists)
23. [Thinking Tool](#23-thinking-tool)
24. [Web Search](#24-web-search)
25. [Skills System](#25-skills-system)
26. [Vulnerability Reporting](#26-vulnerability-reporting)
27. [Finish & Scan Results](#27-finish--scan-results)
28. [Telemetry](#28-telemetry)
29. [GitHub Actions / CI Integration](#29-github-actions--ci-integration)
30. [Installer & Release Pipeline](#30-installer--release-pipeline)
31. [Benchmarks](#31-benchmarks)

---

## 1. CLI Entrypoint & Argument Parsing

**What:** The `strix` command is the single user-facing entrypoint. It parses arguments, validates the environment (Docker, LLM), pulls the sandbox image, then hands off to the interactive TUI or the headless CLI.

**Flags** (see [`parse_arguments`](https://github.com/usestrix/strix/blob/main/strix/interface/main.py)):

| Flag | Description |
|------|-------------|
| `-t/--target` | Target to test. Repeatable. Accepts URLs, git URLs, local paths, domains, IPs. |
| `--instruction` | Inline custom instructions (credentials, focus areas, ROE). |
| `--instruction-file` | Same as above but loaded from a file. Mutually exclusive with `--instruction`. |
| `-n/--non-interactive` | Run headless (no TUI). Exits 2 when vulnerabilities are found. |
| `-m/--scan-mode` | `quick` \| `standard` \| `deep` (default). |
| `--scope-mode` | `auto` \| `diff` \| `full` — diff-scope behavior. |
| `--diff-base` | Base branch/commit for diff-scope comparisons. |
| `--config` | Use a custom JSON config file instead of `~/.strix/cli-config.json`. |
| `-v/--version` | Print version and exit. |

**Code:** [strix/interface/main.py](https://github.com/usestrix/strix/blob/main/strix/interface/main.py), [strix/interface/utils.py](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py).

---

## 2. Interactive TUI

**What:** A [Textual](https://textual.textualize.io/)-based terminal UI for live scan inspection. Shows the root and sub-agent conversations, a streaming view of the current LLM response, tool invocations and outputs, the agent graph, LLM token/cost stats, and vulnerability cards as they land.

**How it works:** `run_tui(args)` (in [strix/interface/tui.py](https://github.com/usestrix/strix/blob/main/strix/interface/tui.py)) starts the root `StrixAgent` and wires its tracer events into Textual widgets. The TUI uses the `Tracer` (see §28) as its data source, so every widget is just a view on a shared state.

**Entry:** `strix --target <target>` (default mode).

---

## 3. Headless / Non-Interactive Mode

**What:** `-n` / `--non-interactive` suppresses the TUI and prints a linear log of streamed LLM content, tool calls, vulnerability cards, and a final report panel. Designed for CI, cron jobs, or remote shells.

**Exit codes:**
- `0` — scan completed, no vulnerabilities.
- `2` — scan completed, **vulnerabilities were found** (used for CI gating).
- Non-zero otherwise — Docker/LLM/config failure, user interrupt, or unhandled exception.

**Code:** [strix/interface/cli.py](https://github.com/usestrix/strix/blob/main/strix/interface/cli.py), exit logic in [strix/interface/main.py](https://github.com/usestrix/strix/blob/main/strix/interface/main.py).

---

## 4. Multi-Target Scanning

**What:** Pass `-t` multiple times to test a set of related assets in one run. Typical combinations:

```bash
strix -t https://github.com/org/app -t https://staging.example.com
strix -t ./backend -t ./frontend -t https://api.example.com
```

Each target is inferred, normalized, and given its own `workspace_subdir`. Repositories are cloned into the workspace before the agent starts; local paths are mounted.

**Code:** `parse_arguments`, `assign_workspace_subdirs`, `collect_local_sources`, `clone_repository` in [strix/interface](https://github.com/usestrix/strix/blob/main/strix/interface).

---

## 5. Target Type Inference

**What:** Strix auto-classifies every `-t` value into one of:

| Type | Trigger |
|------|---------|
| `local_code` | filesystem path that exists |
| `repository` | `https://…git` or `git@…` URL (cloned into `/workspace/<subdir>`) |
| `web_application` | HTTP/HTTPS URL |
| `ip_address` | bare IPv4 |
| `domain` | everything else (validated) |

`localhost`/`127.0.0.1` URLs are automatically rewritten to `host.docker.internal` so the sandbox can reach your dev server.

**Code:** `infer_target_type`, `rewrite_localhost_targets` in [strix/interface/utils.py](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py).

---

## 6. Scan Modes

`--scan-mode` tunes agent aggressiveness:

- **`quick`** — fast CI gate, medium reasoning effort, tight iteration budget, limited skill expansion.
- **`standard`** — routine testing.
- **`deep`** (default) — thorough pentest, largest iteration budget, most reasoning effort.

Modes are implemented as Markdown playbooks in [`strix/skills/scan_modes/`](https://github.com/usestrix/strix/blob/main/strix/skills/scan_modes) that are injected into the root agent's system prompt.

---

## 7. Scope Modes & PR Diff Scoping

`--scope-mode` controls how much of a code target is in primary scope:

- **`auto`** — default. In CI / headless runs (GitHub Actions, `-n`), Strix detects a PR context and restricts the primary review scope to the changed files, with full-repo context available for reasoning.
- **`diff`** — force diff scope. Requires a valid `--diff-base` (e.g. `origin/main`).
- **`full`** — scan the whole codebase regardless of CI.

When diff-scope resolves, the root agent is told:
- which files are in primary scope,
- how many deleted files exist (context-only),
- that unchanged files should only be read for context.

**Code:** `resolve_diff_scope_context` in [strix/interface/utils.py](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py) and consumption in [StrixAgent.execute_scan](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/strix_agent.py).

---

## 8. Custom Instructions

Users can bias the scan with free-form instructions via `--instruction "…"` or `--instruction-file ./file.md`. Common uses:

- Credentials (`admin:hunter2`) for authenticated testing.
- Focus areas (`focus on IDOR and privilege escalation`).
- Rules of engagement / exclusions.
- Specific endpoints to hammer.

The instruction is appended to the scan task and also merged with diff-scope instructions when both are present.

---

## 9. Configuration System & Persistence

**What:** All configuration — LLM, sandbox, telemetry — is env-var-driven via the [`Config`](https://github.com/usestrix/strix/blob/main/strix/config/config.py) class. On every run, Strix saves the current env into `~/.strix/cli-config.json` (mode 0600) and re-applies it on the next run, so you only have to export once.

**Tracked variables** include `STRIX_LLM`, `LLM_API_KEY`, `LLM_API_BASE`, `STRIX_REASONING_EFFORT`, `STRIX_IMAGE`, `PERPLEXITY_API_KEY`, telemetry keys, and more (see `Config._LLM_CANONICAL_NAMES`).

**Override:** `--config <file.json>` loads a custom config file and clears env vars that came from the default to prevent leakage.

**Clearing:** setting a tracked var to empty string at runtime removes it from the saved config.

---

## 10. LLM Provider Abstraction

**What:** Any provider that [LiteLLM](https://github.com/BerriAI/litellm) supports works out of the box — OpenAI, Anthropic, Google Vertex, AWS Bedrock, Azure, Ollama, LMStudio, DeepSeek, Together, Groq, and Strix-hosted models.

**How to switch providers:**
```bash
export STRIX_LLM="anthropic/claude-sonnet-4-6"
export LLM_API_KEY="sk-ant-…"
# or for local
export STRIX_LLM="ollama/llama3.1:70b"
export LLM_API_BASE="http://localhost:11434"
```

Strix-hosted models (`strix/...`) automatically target `https://models.strix.ai/api/v1`.

**Features leveraged automatically when the provider supports them:**
- Streaming completions.
- Prompt caching (`supports_prompt_caching`).
- Reasoning/thinking tokens (`supports_reasoning`).
- Vision (`supports_vision`).

**Code:** [strix/llm/llm.py](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py), [strix/llm/config.py](https://github.com/usestrix/strix/blob/main/strix/llm/config.py), `resolve_llm_config` in [strix/config/config.py](https://github.com/usestrix/strix/blob/main/strix/config/config.py).

---

## 11. Reasoning Effort Control

`STRIX_REASONING_EFFORT` controls how much the model "thinks" before responding. Valid values: `none`, `minimal`, `low`, `medium`, `high` (default), `xhigh`. Quick scans default to `medium` for speed; deep scans use `high`.

---

## 12. Memory Compression

**What:** Long scans would otherwise blow past the model's context window. [`MemoryCompressor`](https://github.com/usestrix/strix/blob/main/strix/llm/memory_compressor.py) summarizes older conversation turns into a compact history once utilization crosses a threshold, preserving recent turns verbatim.

**Timeout:** controlled by `STRIX_MEMORY_COMPRESSOR_TIMEOUT` (default 30s). Runs in a background task so the main agent loop isn't blocked.

Combined with [`dedupe.py`](https://github.com/usestrix/strix/blob/main/strix/llm/dedupe.py) (which collapses repeated tool outputs), this keeps token cost manageable on multi-hour runs.

---

## 13. Docker Sandbox Runtime

**What:** Strix never runs offensive tools on the host. Every sandbox-execution tool is forwarded over HTTP into a Docker container built from [containers/Dockerfile](https://github.com/usestrix/strix/blob/main/containers/Dockerfile).

**Container features:**
- Kali Linux rolling base with `nmap`, `sqlmap`, `nuclei`, `subfinder`, `naabu`, `ffuf`, `httpx`, `katana`, `semgrep`.
- Go toolchain for any on-the-fly installs (projectdiscovery tools).
- Playwright + headless Chromium for the browser tool.
- Caido MITM proxy bound to `48080`.
- FastAPI tool server bound to `48081` (the bridge the host agent talks to).
- A custom root CA (`/app/certs/ca.crt`) trusted inside the container so HTTPS interception works out of the box.
- Network bridge with `host.docker.internal` mapped so scanners can reach a dev server on the host.

**Host side:** [`DockerRuntime`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) pulls the image, picks free host ports, starts the container with a per-run auth token, recovers state on reconnect, and cleans up on exit. Sources are mounted into `/workspace/<subdir>`.

**Override the image:** `export STRIX_IMAGE=your-registry/strix-sandbox:tag`.

---

## 14. Tool Registry

**What:** Tools are Python functions decorated with `@register_tool(...)` that the LLM invokes via XML blocks in its replies. Each tool ships a matching `*_schema.xml` file describing its parameters — that XML is injected into the system prompt so the model knows the call shape.

Key features of the registry ([strix/tools/registry.py](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py)):
- **Module-scoped grouping** — tools are grouped by module in the prompt (`<browser_tools>…</browser_tools>`).
- **Sandbox routing** — functions flagged `sandbox_execution=True` are forwarded to the container tool server; others run in-process on the host.
- **Conditional registration** — tools that depend on a capability (`requires_browser_mode`, `requires_web_search_mode`) silently omit themselves when the capability isn't configured. Disable the browser with `STRIX_DISABLE_BROWSER=true`, for example.
- **Dynamic schema slots** — `{{DYNAMIC_SKILLS_DESCRIPTION}}` in a schema is replaced at load time with the live list of available skills (powers `load_skill`).

**Invocation flow:** assistant reply → XML parser ([`llm/utils.py`](https://github.com/usestrix/strix/blob/main/strix/llm/utils.py)) → `process_tool_invocations` in [strix/tools/executor.py](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py) → either direct function call or HTTP POST to the sandbox tool server.

---

## 15. Multi-Agent Graph

**What:** The root agent can call `create_agent(task, name, skills=…)` to spawn a focused sub-agent. Each sub-agent has its own conversation history, its own set of up-to-5 skills, and runs independently until it calls `agent_finish`.

**Graph structure:** `{nodes: {agent_id: AgentNode}, edges: [{from, to, type: "delegation"}]}`. Nodes track task, status (`running` / `waiting_for_input` / `completed` / `failed` / `stopped`), start/finish time, result, and rolled-up LLM stats.

**Why this matters:** the model gets horizontal scalability — a pentest on a large app becomes "spawn one agent per attack surface and collate their reports" instead of one giant monolithic chain-of-thought that blows the context window.

**Code:** [strix/tools/agents_graph/agents_graph_actions.py](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py) and [BaseAgent._add_to_agents_graph](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py).

---

## 16. Inter-Agent Messaging

**What:** Agents can exchange messages using `send_agent_message` / `wait_for_message`. Messages are queued per recipient and delivered the next time the recipient's loop drains its inbox ([`_check_agent_messages`](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py)).

Each delivered message is wrapped in an `<inter_agent_message>` XML block containing sender name, priority, timestamp, and payload — so the receiving agent knows whether it's a user message or a peer.

---

## 17. HTTP Proxy (Caido)

**What:** The sandbox runs a Caido MITM proxy on port `48080`. Tools in [`strix/tools/proxy/`](https://github.com/usestrix/strix/blob/main/strix/tools/proxy) let the agent:

- List intercepted requests and responses.
- Replay, modify, and re-send requests.
- Filter by host, method, status.
- Dump full request/response bodies.

Because the sandbox's root CA is trusted inside the container, HTTPS traffic from the browser / curl / any tool is transparent. The UI port is exposed to the host (`caido_port` in [DockerRuntime](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py)) so you can browse intercepted traffic from your laptop.

---

## 18. Browser Automation

**What:** A Playwright-driven headless Chromium runs inside the sandbox. Tools in [`strix/tools/browser/`](https://github.com/usestrix/strix/blob/main/strix/tools/browser) expose:

- Multi-tab management (`tab_manager.py`).
- Navigate, click, type, select, submit forms, upload files.
- Read DOM, take screenshots, wait for selectors/network idle.
- Execute arbitrary JavaScript in page context.
- Full cookie / local storage inspection.

Ideal for testing XSS, CSRF, auth flows, SSO redirects, DOM sinks, client-side state machines.

Disable entirely with `STRIX_DISABLE_BROWSER=true` to save memory on tiny CI runners.

---

## 19. Terminal Sessions

**What:** Persistent `tmux` + `pyte` backed shells inside the sandbox ([`strix/tools/terminal/`](https://github.com/usestrix/strix/blob/main/strix/tools/terminal)). The agent can:

- Start a named session.
- Send input (full line or raw keys like Ctrl-C).
- Read screen state with ANSI rendering.
- Run any Kali CLI tool available in the image (`nmap`, `sqlmap`, `nuclei`, …).
- Keep long-running processes alive between tool calls.

---

## 20. Python Runtime

**What:** An IPython kernel runs in the sandbox ([`strix/tools/python/`](https://github.com/usestrix/strix/blob/main/strix/tools/python)). The agent can execute Python — import `requests`, craft payloads, compute hashes, parse JSON, decode JWTs, run small exploit scripts — with state preserved across calls.

Perfect for PoC development without spinning up a shell.

---

## 21. File Editing

**What:** [`strix/tools/file_edit/`](https://github.com/usestrix/strix/blob/main/strix/tools/file_edit) provides read/write/patch access to files inside the sandbox workspace. Backed by [openhands-aci](https://pypi.org/project/openhands-aci/) for safe patch application. Used when the agent needs to modify mounted source code — e.g. to propose a fix PoC, instrument code for tracing, or write test cases.

---

## 22. Notes & TODO Lists

- **Notes** ([`strix/tools/notes/`](https://github.com/usestrix/strix/blob/main/strix/tools/notes)) — append-only scratchpad per agent. Used to record hypotheses, suspicious URLs, credentials discovered, and cross-reference information that shouldn't leave the context window.
- **TODO list** ([`strix/tools/todo/`](https://github.com/usestrix/strix/blob/main/strix/tools/todo)) — a structured checklist the agent maintains to plan its own work. The TUI renders it live.

Both survive across iterations and show up in the scan artifacts.

---

## 23. Thinking Tool

**What:** A dedicated [`thinking`](https://github.com/usestrix/strix/blob/main/strix/tools/thinking) tool gives the model a structured place to reason out loud without polluting the final response. Complements the provider-level reasoning tokens — useful with models that don't support native thinking.

---

## 24. Web Search

**What:** [`strix/tools/web_search/`](https://github.com/usestrix/strix/blob/main/strix/tools/web_search) uses [Perplexity](https://perplexity.ai) to answer freshly-sourced questions — CVE lookups, vendor docs, exploit PoCs, rate-limit defaults. Only registered when `PERPLEXITY_API_KEY` is set.

---

## 25. Skills System

**What:** Skills are Markdown playbooks that get injected into an agent's system prompt to give it domain expertise. Each skill has YAML frontmatter (`name`, `description`) and a body full of advanced techniques, payloads, and validation steps.

**Built-in categories** (see [strix/skills/](https://github.com/usestrix/strix/blob/main/strix/skills)):

| Category | Examples |
|----------|----------|
| `vulnerabilities` | `sql_injection`, `xss`, `ssrf`, `xxe`, `idor`, `rce`, `csrf`, `authentication_jwt`, `race_conditions`, `path_traversal_lfi_rfi`, `mass_assignment`, `open_redirect`, `subdomain_takeover`, `information_disclosure`, `insecure_file_uploads`, `business_logic`, `broken_function_level_authorization` |
| `frameworks` | `fastapi`, `nestjs`, `nextjs` |
| `technologies` | `supabase`, `firebase_firestore` |
| `protocols` | `graphql` |
| `cloud` | `kubernetes` |
| `tooling` | `nmap`, `nuclei`, `httpx`, `ffuf`, `naabu`, `katana`, `sqlmap`, `subfinder`, `semgrep` |
| `reconnaissance` | (extensible) |
| `coordination` | `root_agent`, `source_aware_whitebox` (internal) |
| `custom` | `source_aware_sast` + community contributions |
| `scan_modes` | `quick`, `standard`, `deep` (internal) |

**Loading:** the root agent gets `root_agent` by default. Any agent can call `load_skill` (or pass `skills=` to `create_agent`) to pull in up to 5 skills. The loader strips frontmatter and merges skill bodies into the prompt ([strix/skills/__init__.py](https://github.com/usestrix/strix/blob/main/strix/skills/__init__.py)).

**Contributing:** drop a new `.md` into the right category (or `custom/`) and submit a PR. See [strix/skills/README.md](https://github.com/usestrix/strix/blob/main/strix/skills/README.md).

---

## 26. Vulnerability Reporting

**What:** The `reporting` tool ([`strix/tools/reporting/`](https://github.com/usestrix/strix/blob/main/strix/tools/reporting)) emits structured vulnerability findings that the tracer surfaces in the UI and persists to disk. Each finding includes:

- Title, description, affected asset.
- CVSS vector + computed score (via the `cvss` package).
- Severity (Critical / High / Medium / Low / Info).
- Reproduction steps, PoC, and request/response evidence.
- Suggested remediation.

Findings are rendered as cards in the TUI and streamed to stdout in headless mode.

---

## 27. Finish & Scan Results

**What:** Two finish tools close out agents ([`strix/tools/finish/`](https://github.com/usestrix/strix/blob/main/strix/tools/finish)):

- `finish_scan` (root agent only) — closes the whole scan.
- `agent_finish` (sub-agents) — returns a result to the parent agent.

When the scan ends (either via `finish_scan`, max iterations, or user exit), Strix writes artifacts to `strix_runs/<run-name>/`:
- conversation transcripts,
- tool invocation logs,
- vulnerability reports,
- scan metadata (model, scan mode, LLM stats, exit reason).

Headless mode then prints a summary panel and exits with code **2** if vulnerabilities were found, otherwise **0**.

---

## 28. Telemetry

Three independent telemetry layers, all **off by default** in the frontend sense (you control them):

- **Tracer** ([`strix/telemetry/tracer.py`](https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py)) — an in-process event bus. Tracks agent creation, streaming content, tool executions, chat messages, vulnerability reports, LLM stats, and scan config. The TUI and CLI are both built on top of it. Always on; purely local.
- **PostHog** ([`strix/telemetry/posthog.py`](https://github.com/usestrix/strix/blob/main/strix/telemetry/posthog.py)) — optional anonymous product analytics (scan_start / scan_end / error events). Controlled by `STRIX_POSTHOG_TELEMETRY` and the global `STRIX_TELEMETRY=0` kill switch.
- **OpenTelemetry / Traceloop** ([`tracer.py`](https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py) wiring) — optional distributed tracing exporter for production deployments. Configured via `TRACELOOP_BASE_URL`, `TRACELOOP_API_KEY`, `TRACELOOP_HEADERS`, or the standard `OTEL_*` env vars.

Set `STRIX_TELEMETRY=0` to opt out of everything except the local tracer.

---

## 29. GitHub Actions / CI Integration

**What:** The one-line installer and `-n` mode make Strix drop-in for pipelines. In a `pull_request` context with `fetch-depth: 0`, `auto` scope mode narrows the review to changed files automatically.

Recommended pattern:

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 0
- run: curl -sSL https://strix.ai/install | bash
- env:
    STRIX_LLM: ${{ secrets.STRIX_LLM }}
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
  run: strix -n -t ./ --scan-mode quick
```

Because headless mode returns `2` on findings, you can gate merges on a green Strix job without any extra wrapping.

---

## 30. Installer & Release Pipeline

**What:** [`scripts/install.sh`](https://github.com/usestrix/strix/blob/main/scripts/install.sh) detects the OS/arch, downloads the matching release asset, extracts the frozen binary into `~/.strix/bin`, and optionally pre-pulls the sandbox image.

**Supported platforms:** Linux x86_64, macOS x86_64/arm64 (with Rosetta detection), Windows x86_64.

**Release artifacts:** built with PyInstaller from [strix.spec](strix.spec). [`scripts/build.sh`](https://github.com/usestrix/strix/blob/main/scripts/build.sh) is the developer helper to produce the archive locally. [`scripts/docker.sh`](https://github.com/usestrix/strix/blob/main/scripts/docker.sh) builds the sandbox image.

---

## 31. Benchmarks

The [benchmarks/](https://github.com/usestrix/strix/tree/main/benchmarks) directory hosts security benchmark harnesses used to measure detection quality against known-vulnerable apps. See [benchmarks/README.md](https://github.com/usestrix/strix/blob/main/benchmarks/README.md) for the current suites and how to run them.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — install, build, usage, architecture.
- [strix/skills/README.md](https://github.com/usestrix/strix/blob/main/strix/skills/README.md) — authoring skills.
- [docs/](docs/) — Mintlify source for [docs.strix.ai](https://docs.strix.ai).
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow and PR process.
