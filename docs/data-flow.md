# Strix Data Flow: Storage → Tool Input → Response Processing

How sources, API keys, and user settings are stored, how each piece reaches a running tool, and how tool responses make their way back into the conversation, the persisted artifacts, and the telemetry pipeline.

> **TL;DR.** Settings live in `~/.strix/cli-config.json` and env vars; sources live as a tar-streamed copy inside `/workspace/<subdir>` in the container; secrets (LLM API key, sandbox auth token) **never enter the LLM context** — they ride config or per-run agent state. Tool inputs reach the sandbox over a Bearer-authed HTTPS POST that carries `{agent_id, tool_name, kwargs}`. Tool responses come back as a single `{result|error}` JSON, get truncated to 10 k chars, screenshots pulled out as image blocks, wrapped in `<tool_result>` XML, appended to that agent's `state.messages` as a user-role turn, sanitized through `scrubadub`, and persisted to `strix_runs/<run-name>/`.

---

## Table of Contents

1. [The Six Data Domains](#1-the-six-data-domains)
2. [Storage Locations Map](#2-storage-locations-map)
3. [User Settings & API Keys](#3-user-settings--api-keys)
4. [Targets, Sources & Authorized Scope](#4-targets-sources--authorized-scope)
5. [Per-Run State](#5-per-run-state)
6. [How Settings Reach the LLM](#6-how-settings-reach-the-llm)
7. [How Inputs Reach a Tool](#7-how-inputs-reach-a-tool)
8. [How a Tool Response Comes Back](#8-how-a-tool-response-comes-back)
9. [Persistence to `strix_runs/`](#9-persistence-to-strix_runs)
10. [Sanitization & Redaction](#10-sanitization--redaction)
11. [What Crosses Which Boundary](#11-what-crosses-which-boundary)

---

## 1. The Six Data Domains

Strix stores six conceptually distinct kinds of data. Each has its own location, owner, and lifetime.

| Domain | Examples | Stored in | Lifetime |
|---|---|---|---|
| **User settings** | `STRIX_LLM`, `STRIX_REASONING_EFFORT`, `STRIX_IMAGE`, telemetry flags | `~/.strix/cli-config.json` (mode 0600) + env vars | Across runs (per OS user) |
| **API keys / secrets (host)** | `LLM_API_KEY`, `PERPLEXITY_API_KEY`, `TRACELOOP_API_KEY` | Same file + env vars; **never sent into the LLM context** | Across runs |
| **Per-run auth (sandbox)** | `sandbox_token` (Bearer), `sandbox_id` (container id) | In-memory `AgentState` + container env var; never persisted to disk | Single run |
| **Targets & user instructions** | `--target`, `--instruction`, `--instruction-file`, `--scope-mode`, `--diff-base` | `args` namespace → first task message + system prompt context | Single run |
| **Source code** | local paths, cloned repos | Host: `<tmp>/strix_repos/<run-name>/`. Container: `/workspace/<subdir>` | Single run (cloned tmp is not auto-removed) |
| **Run artifacts** | conversations, tool I/O, vulnerability reports, run metadata | Host: `strix_runs/<run-name>/` | Persisted indefinitely |

The key invariant: **secrets stay in domains 1–3; domains 4–6 are what the LLM and tools actually see.**

---

## 2. Storage Locations Map

```
HOST FILESYSTEM
├─ ~/.strix/
│   ├─ bin/strix                    ← installer-provided binary
│   └─ cli-config.json (0600)       ← {"env": {STRIX_LLM:..., LLM_API_KEY:..., ...}}
│
├─ <cwd>/strix_runs/<run-name>/    ← per-run artifacts (persisted)
│   ├─ run_metadata.json            ← run config, end_time, status
│   ├─ events.jsonl                 ← tracer event stream (sanitized)
│   ├─ penetration_test_report.md   ← root agent's final report
│   ├─ vulnerabilities/
│   │   ├─ vuln-0001.md
│   │   └─ vuln-0002.md
│   └─ scan_results.json            ← (when present) executive summary structured form
│
├─ <tmpdir>/strix_repos/<run-name>/<repo>/   ← cloned repos (host-side staging)
│
├─ Process memory:
│   ├─ Config class                  ← env-backed settings
│   ├─ AgentState                    ← per-agent: messages, sandbox_token, iteration, errors
│   ├─ _agent_graph                  ← global registry (nodes, edges, inboxes)
│   └─ Tracer                        ← event log + scan_results + vulnerability_reports

DOCKER SANDBOX (one container per run, fresh each time)
├─ /workspace/<subdir>/             ← tar-streamed copy of each source target
├─ /home/pentester/                 ← image-baked offensive toolchain
├─ /app/certs/{ca.crt,ca.key,ca.p12} ← MITM CA (image-baked)
├─ env: TOOL_SERVER_TOKEN=<256-bit secret>   ← per run
└─ FastAPI tool server (port 48081, Bearer-authed)
```

---

## 3. User Settings & API Keys

### Source of truth

The [`Config`](https://github.com/usestrix/strix/blob/main/strix/config/config.py) class exposes one method, `Config.get(name)`, which reads `os.getenv(NAME)` first, then falls back to the class-level default. So **environment variables always win** at read time.

### Persistence

[`apply_saved_config()`](https://github.com/usestrix/strix/blob/main/strix/config/config.py) at process start:

1. Reads `~/.strix/cli-config.json` (or the path passed to `--config`).
2. For each tracked variable that's **not** already in `os.environ`, sets `os.environ[name] = value`.
3. Records the applied set so a later `--config` override can clear them cleanly.

[`save_current_config()`](https://github.com/usestrix/strix/blob/main/strix/config/config.py) at the right point in `main.main`:

1. Reads the existing config file (or starts from `{}`).
2. For each tracked variable in `Config._tracked_names()`:
   - If currently set in env → upsert into the saved map.
   - If explicitly empty string → remove from saved map.
3. Writes JSON with `chmod 0o600` (best-effort; skipped silently on Windows).

Effect: anything you `export STRIX_LLM=…` once is persisted; anything you `export STRIX_LLM=""` clears the saved value.

### Tracked variables

The tracked set is auto-derived from class attributes (`_tracked_names()` returns every lowercase-typed `str | None` class attribute, then uppercased). Currently:

| Variable | Default | Notes |
|---|---|---|
| `STRIX_LLM` | — | Required. LiteLLM model id like `openai/gpt-5.4`. |
| `LLM_API_KEY` | — | Optional for local / Vertex / Bedrock. |
| `LLM_API_BASE`, `OPENAI_API_BASE`, `LITELLM_BASE_URL`, `OLLAMA_API_BASE` | — | Local/proxy endpoints. |
| `STRIX_REASONING_EFFORT` | `high` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`. |
| `STRIX_LLM_MAX_RETRIES` | `5` | Retry budget for `LLM.generate`. |
| `STRIX_MEMORY_COMPRESSOR_TIMEOUT` | `30` | Seconds. |
| `LLM_TIMEOUT` | `300` | Seconds, per-completion. |
| `PERPLEXITY_API_KEY` | — | Enables `web_search` tool registration. |
| `STRIX_DISABLE_BROWSER` | `false` | Skips `browser_*` registration when true. |
| `STRIX_IMAGE` | `ghcr.io/usestrix/strix-sandbox:0.1.13` | Sandbox image. |
| `STRIX_RUNTIME_BACKEND` | `docker` | Runtime selection. |
| `STRIX_SANDBOX_EXECUTION_TIMEOUT` | `120` | Per-tool timeout in container. |
| `STRIX_SANDBOX_CONNECT_TIMEOUT` | `10` | TCP connect timeout. |
| `STRIX_TELEMETRY` | `1` | Master kill switch (`0` = no PostHog/OTEL). |
| `STRIX_OTEL_TELEMETRY`, `STRIX_POSTHOG_TELEMETRY` | — | Sub-toggles. |
| `TRACELOOP_BASE_URL`, `TRACELOOP_API_KEY`, `TRACELOOP_HEADERS` | — | OTEL exporter config. |

### LLM-specific subset

`Config._LLM_CANONICAL_NAMES` is the subset that controls which provider you talk to. If any of those env vars change between runs, the `Config.apply_saved` step **clears** the entire saved LLM block before re-reading — so switching provider doesn't leave stale `OLLAMA_API_BASE` lying in the file.

### `--config <file>` override

Passed at the CLI, this:

1. Validates the file exists and is JSON (`validate_config_file`).
2. Calls `apply_config_override(path)`:
   - Pops every env var that was applied from the default config so it can't leak.
   - Clears `Config._applied_from_default`.
   - Sets `Config._config_file_override = path`.
   - Re-runs `apply_saved_config(force=True)` against the new file.
3. Suppresses `save_current_config()` for the rest of the run (`persist_config()` only saves when `_config_file_override is None`).

So custom config files never silently "stick" — they're scoped to the invocation.

---

## 4. Targets, Sources & Authorized Scope

### CLI input

```bash
strix -t <target> [-t <target> ...]
      [--instruction "..."] [--instruction-file ./roe.md]
      [--scope-mode auto|diff|full] [--diff-base origin/main]
```

[`parse_arguments`](https://github.com/usestrix/strix/blob/main/strix/interface/main.py) classifies each `-t` value via `infer_target_type` into one of:

| Type | Trigger |
|---|---|
| `local_code` | filesystem path that exists |
| `repository` | `https://…git`, `git@…` URL |
| `web_application` | HTTP(S) URL |
| `ip_address` | bare IPv4 |
| `domain` | everything else (validated) |

Each entry becomes `{"type": …, "details": {…}, "original": …}` in `args.targets_info`. `assign_workspace_subdirs` then gives each code target a unique `workspace_subdir` so multiple repos coexist under `/workspace/`.

### Repository cloning (host-side staging)

Repository targets are cloned into `<tmpdir>/strix_repos/<run_name>/<repo>/` by [`clone_repository`](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py) **before** the container starts. The path is then attached to `target.details["cloned_repo_path"]` and treated thereafter like a local-code source.

### Local sources → `/workspace`

After the container is up, [`DockerRuntime._copy_local_directory_to_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) tar-streams each source path into `/workspace/<subdir>` via `container.put_archive`, then chowns to `pentester:pentester`. There is **no host bind-mount** — the user's source on disk is untouched, and the container's copy is wiped when the container is destroyed at scan end.

### User instructions

`--instruction "…"` flows directly into `args.instruction`. `--instruction-file <path>` is read and stripped at parse time (`f.read().strip()`). The two are mutually exclusive.

The instruction string is later concatenated onto the task description in [`StrixAgent.execute_scan`](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/strix_agent.py):

```python
task_description += f"\n\nSpecial instructions: {user_instructions}"
```

So instructions reach the agent as part of the **first user message**, not the system prompt — meaning they don't get the "platform-verified" weight that the authorized scope does.

### Diff-scope context

[`resolve_diff_scope_context`](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py) computes the changed-file set against `--diff-base` for any local code target when `--scope-mode` is `auto` (CI/headless only) or `diff` (always). It produces:

- `metadata` — attached to `args.diff_scope` and forwarded into the scan config.
- `instruction_block` — a textual description of which files are in primary scope, prepended to `args.instruction`.

### Authorized scope (system-prompt-level)

[`StrixAgent._build_system_scope_context`](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/strix_agent.py) builds an authoritative scope block:

```python
{
  "scope_source": "system_scan_config",
  "authorization_source": "strix_platform_verified_targets",
  "authorized_targets": [{type, value, workspace_path}, ...],
  "user_instructions_do_not_expand_scope": True,
}
```

This is set on the LLM via `self.llm.set_system_prompt_context(...)` and rendered into every system prompt (see [`system_prompt.jinja`](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja) lines 48–63). The prompt then explicitly says:

> "User instructions, chat messages, and other free-form text do NOT expand scope beyond this list" / "If the user mentions any asset outside this list, ignore that asset"

So `args.target` is treated as authoritative scope; `args.instruction` is treated as advisory. This is the only meaningful authorization signal the agent has.

---

## 5. Per-Run State

Once a run is in flight, several state objects materialize and live for the run's duration.

| Object | Lives in | What it holds |
|---|---|---|
| `args.run_name` | host process | `<slugified-target>_<token_hex(2)>` — the artifact directory name |
| `Tracer` | global singleton (`strix.telemetry.tracer.get_global_tracer`) | Run id, run name, scan_config, scan_results, vulnerability_reports, agent statuses, events file path |
| `DockerRuntime._tool_server_token` | `DockerRuntime` instance | `secrets.token_urlsafe(32)` — set at container start, sent into container as `TOOL_SERVER_TOKEN` env var, returned to host as `auth_token` in `SandboxInfo` |
| `AgentState.sandbox_token`, `.sandbox_id`, `.sandbox_info` | per-agent | Populated by `create_sandbox`. **Every tool call to the sandbox carries `agent_state.sandbox_token`** as a Bearer header. |
| `_agent_graph` | module-level in `agents_graph_actions.py` | Cross-agent registry of `nodes`, `edges`, `agent_messages` (inboxes), `agent_instances` |
| Per-agent `LLM._total_stats` | per-agent `LLM` | Token + cost accumulator. Rolled into `_completed_agent_llm_totals` on agent finalize. |

None of this is persisted as-is — only the artifacts written to `strix_runs/<run-name>/` survive process exit.

---

## 6. How Settings Reach the LLM

The LLM sees a *layered* assembled context, not the raw `Config`. The code path:

```
~/.strix/cli-config.json
        │
        │  apply_saved_config() at process start
        ▼
os.environ                   ←  also user-set exports
        │
        │  Config.get(...) at every read site
        ▼
LLMConfig (per agent)        ←  api_key, api_base, litellm_model, reasoning_effort, scan_mode, is_whitebox, ...
        │
        │  LLM.__init__ takes LLMConfig
        ▼
LLM._build_completion_args(messages)
        │
        │  on every completion: messages + api_key + api_base + reasoning_effort
        ▼
litellm.acompletion(model=..., messages=..., api_key=..., api_base=..., reasoning_effort=..., timeout=..., stream=True)
```

Crucially, **`api_key` flows through `LLMConfig.api_key` directly into `litellm.acompletion`** — it's not part of the `messages` list. The LLM provider sees it as the HTTP `Authorization` header; the model itself never sees the key text.

### What's in `messages` (the actual model input)

[`_prepare_messages`](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py) builds:

```python
[
  {"role": "system", "content": self.system_prompt},          # rendered Jinja
  {"role": "user", "content": "<agent_identity>...</...>"},   # internal metadata
  *self.memory_compressor.compress_history(state.messages),    # the conversation
  ({"role": "user", "content": "<meta>Continue the task.</meta>"}  # if last is assistant + non-interactive
   if applicable else nothing)
]
```

If the model supports prompt caching (Anthropic) and `enable_prompt_caching=True`, the system prompt and most-recent user message get `cache_control` markers added by `_add_cache_control`.

If the model doesn't support vision, `_strip_images` replaces every `image_url` block with `[Image removed - model doesn't support vision]` text.

### What's in the system prompt

[`_load_system_prompt`](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py) renders [`strix/agents/StrixAgent/system_prompt.jinja`](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja) with:

| Variable | Source | Purpose |
|---|---|---|
| `get_tools_prompt` | function from registry | Renders every registered tool's XML schema, grouped by module |
| `loaded_skill_names` | `LLMConfig.skills` resolved through `load_skills` | Names of skills currently active |
| `interactive` | `LLMConfig.interactive` | Branches behavior text (TUI vs headless) |
| `system_prompt_context` | `_build_system_scope_context` | Authorized targets, scope source |
| `**skill_content` | `load_skills(...)` | Each loaded skill's Markdown content as a Jinja variable |

The system prompt is ~800 lines long and rebuilt only when skills are added (`add_skills` calls `_load_system_prompt` again) or scope context changes.

---

## 7. How Inputs Reach a Tool

Two transports — local (in-process) and sandbox (HTTPS POST). Both start from the same dispatch logic in [`executor.py`](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py).

### Step 1 — LLM emits the call

Assistant text contains:

```xml
<function=tool_name>
  <parameter=p1>value1</parameter>
  <parameter=p2>value2</parameter>
</function>
```

`parse_tool_invocations` in [strix/llm/utils.py](https://github.com/usestrix/strix/blob/main/strix/llm/utils.py) extracts a list of `{"toolName", "args"}` dicts. All `args` values are **strings at this point** (they came out of XML).

### Step 2 — Validation

`execute_tool_with_validation`:

1. `validate_tool_availability(tool_name)` — name must be in `_tools_by_name` for *this side* (host vs sandbox).
2. `_validate_tool_arguments(tool_name, kwargs)` — checks against the XML schema's `<parameter required="…">` set:
   - Reject unknown params with a hint listing valid params.
   - Reject missing required params with the same hint.

Validation errors are returned as `"Error: …"` strings (not exceptions) so the LLM sees them on the next turn and can self-correct.

### Step 3 — Argument coercion

`convert_arguments` (in [strix/tools/argument_parser.py](https://github.com/usestrix/strix/blob/main/strix/tools/argument_parser.py)) walks `inspect.signature(tool_func).parameters` and casts strings to the function's annotated types: `int`, `float`, `bool` (via `_convert_to_bool`), `list[Any]` (JSON-or-CSV), `dict[str, Any]` (JSON), or fallthrough `json.loads`.

### Step 4 — Local vs sandbox split

```python
if should_execute_in_sandbox(tool_name) and not STRIX_SANDBOX_MODE:
    return await _execute_tool_in_sandbox(tool_name, agent_state, **kwargs)
return await _execute_tool_locally(tool_name, agent_state, **kwargs)
```

### Local path

`_execute_tool_locally` calls the registered function in-process, passing `agent_state=...` if `needs_agent_state(tool_name)`. Awaits the result if it's a coroutine.

Tools on the local path:

- `create_agent`, `send_message_to_agent`, `wait_for_message`, `agent_finish`, `view_agent_graph`, `finish_scan`
- `notes_*`, `todo_*`, `thinking`, `load_skill`
- `web_search`, `create_vulnerability_report`

These mutate host-side state (agent graph, vuln registry, notes/todos store) and don't need the sandbox.

### Sandbox path

`_execute_tool_in_sandbox` does the HTTPS POST:

```python
request_data = {
    "agent_id":   agent_state.agent_id,
    "tool_name":  tool_name,
    "kwargs":     kwargs,                     # already type-coerced strings/ints/etc.
}

headers = {
    "Authorization": f"Bearer {agent_state.sandbox_token}",
    "Content-Type": "application/json",
}

timeout = httpx.Timeout(SANDBOX_EXECUTION_TIMEOUT, connect=SANDBOX_CONNECT_TIMEOUT)

async with httpx.AsyncClient(trust_env=False) as client:
    response = await client.post(f"{server_url}/execute", json=request_data, headers=headers, timeout=timeout)
```

What the kwargs do **not** include:

- The `LLM_API_KEY`. Tools never need to call the LLM provider directly — the agent loop is the only LLM caller.
- The `PERPLEXITY_API_KEY` for sandbox tools. (`web_search` is a host-only tool.)
- Any other host secrets.

What they **do** include for tools that need credentials (e.g. authenticated proxy, JWT token analysis):

- The values literally typed by the LLM into the tool call. So if the model's instruction said "use credentials admin:hunter2", those credentials become `kwargs["body"]` or similar — they cross the boundary as part of the call payload.

### Step 5 — Sandbox dispatch

[`tool_server.execute_tool`](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py):

1. `verify_token(credentials)` against `EXPECTED_TOKEN` (the per-run token passed at server start).
2. `_run_tool(agent_id, tool_name, kwargs)`:
   - `set_current_agent_id(agent_id)` — sets the `current_agent_id` ContextVar so per-agent session managers (`TerminalManager`, `PythonManager`, `tab_manager`) route to the right pane/kernel/tab.
   - `convert_arguments(tool_func, kwargs)` again (the kwargs were JSON-decoded so a couple of types may need re-coercing).
   - `await asyncio.to_thread(tool_func, **converted_kwargs)`.
3. Wraps in `asyncio.wait_for(..., timeout=REQUEST_TIMEOUT)`.

A second concurrent call for the same `agent_id` cancels the first (the per-agent task slot in §11 of multiagent.md).

---

## 8. How a Tool Response Comes Back

```
tool function returns dict|str|None
        │
        ▼
ToolExecutionResponse(result=..., error=...)            ← tool_server.py
        │
        ▼  HTTP 200 JSON {result|error}
        │
host: _execute_tool_in_sandbox
        │   if response_data["error"] → raise RuntimeError(...)
        │   else → return response_data["result"]
        │
        ▼
host: _execute_single_tool                               ← executor.py
        │
        │  _check_error_result(result)
        │     • result.get("error") in dict → is_error=True
        │     • str result starting "error:" → is_error=True
        │
        │  tracer.update_tool_execution(execution_id, status, result|error)
        │
        ▼
host: _format_tool_result(tool_name, result)
        │
        │  1. extract_screenshot_from_result(result)
        │       if result is dict and result["screenshot"] is non-empty str:
        │         · take base64 png, build {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
        │         · result["screenshot"] = "[Image data extracted - see attached image]"
        │
        │  2. coerce result to str
        │       None → "Tool {tool_name} executed successfully"
        │       else → str(result)
        │
        │  3. truncation guard
        │       if len > 10000:
        │         · keep first 4000 + "[middle content truncated]" + last 4000
        │
        │  4. wrap in <tool_result>
        │       <tool_result>
        │         <tool_name>{tool_name}</tool_name>
        │         <result>{final_result_str}</result>
        │       </tool_result>
        │
        ▼
host: process_tool_invocations aggregates per-call wrappers
        │
        │  · One tool_result block per call
        │  · If any images extracted → user message becomes a list-of-blocks
        │      [{type:"text", text:"Tool Results:\n\n<...><...>"},
        │       {type:"image_url", image_url:{url:"data:..."}},
        │       ...]
        │  · Else → plain string content "Tool Results:\n\n<...><...>"
        │
        │  conversation_history.append({"role": "user", "content": ...})
        │
        ▼
state.messages now contains the result; next iteration LLM sees it
```

### Why a `user` role and not `tool` role?

Strix supports any LiteLLM-compatible provider, including ones that lack a native `tool` role. Wrapping tool results in a user-role turn that contains XML works uniformly across OpenAI / Anthropic / Vertex / Bedrock / Ollama / LMStudio.

### Why image blocks instead of base64-in-text?

Inlining base64 would consume thousands of tokens. The block form sends the image as a separate content part that vision-capable models can attend to; vision-incapable models get the text replacement courtesy of `_strip_images`.

### Should-finish flag

Two specific tools mutate the loop's exit condition based on their result:

- `finish_scan` returns `{"scan_completed": True}` → loop sets `should_agent_finish=True` for the root.
- `agent_finish` returns `{"agent_completed": True}` → loop sets `should_agent_finish=True` for sub-agents.

Both are checked by name in [`_execute_single_tool`](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py).

---

## 9. Persistence to `strix_runs/`

The [`Tracer`](https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py) is the single point of persistence. Every important event is logged through it; it materializes them onto disk.

### Files written

| File | Written by | When |
|---|---|---|
| `strix_runs/<run-name>/run_metadata.json` | `Tracer._emit_run_started_event` and `save_run_data` | Run start; updated at end with `status: "completed"` |
| `strix_runs/<run-name>/events.jsonl` | `Tracer._emit_event` | Every agent creation, tool execution, status change, finding, run lifecycle event |
| `strix_runs/<run-name>/penetration_test_report.md` | `Tracer.save_run_data` | When `final_scan_result` is set by `finish_scan` |
| `strix_runs/<run-name>/vulnerabilities/vuln-NNNN.md` | `Tracer.save_run_data` | After every successful `create_vulnerability_report` (gated by dedupe) |

### Vulnerability report file shape

`save_run_data` writes one Markdown file per finding (`vuln-0001.md`, `vuln-0002.md`, …) sorted by severity then time. Each file contains:

- Title, ID, severity, timestamp.
- Optional metadata: target, endpoint, method, CVE, CWE, CVSS.
- Description, Impact, Technical Analysis, Proof of Concept (with code block), Code Analysis (file + line refs), Remediation.

Newly committed reports are written incrementally — `_saved_vuln_ids` tracks what's already on disk so the file write is idempotent.

### Event stream

Each event in `events.jsonl` is a single JSON line. Every event passes through `TelemetrySanitizer.sanitize` first (see §10). Common event types:

- `run.started` / `run.ended`
- `agent.created` / `agent.status_changed`
- `tool.execution_started` / `tool.execution_completed` / `tool.execution_error`
- `chat.message`
- `finding.created`

The JSONL file is the source for downstream tooling — tail it for live status, replay for post-mortem.

### What is **not** written

- Raw screenshots (replaced with `[SCREENSHOT_OMITTED]` per [`_SCREENSHOT_KEY_PATTERN`](https://github.com/usestrix/strix/blob/main/strix/telemetry/utils.py)).
- API keys / Bearer tokens (sanitizer strips matching keys + token patterns).
- The `sandbox_token` (never logged).
- The system prompt verbatim (only its *rendering* leaves a trace via `chat.message` events for LLM input).

---

## 10. Sanitization & Redaction

Two layers of redaction protect against accidental secret leakage:

### Layer 1 — Schema-level key filtering ([`TelemetrySanitizer`](https://github.com/usestrix/strix/blob/main/strix/telemetry/utils.py))

For every `dict` written to telemetry:

```python
_SENSITIVE_KEY_PATTERN = (
    r"(api[_-]?key|token|secret|password|"
    r"authorization|cookie|session|credential|private[_-]?key)"
)
```

If any dict key matches → the value is replaced with `[REDACTED]`, regardless of value.

`_SCREENSHOT_KEY_PATTERN = re.compile(r"screenshot", re.IGNORECASE)` → replaced with `[SCREENSHOT_OMITTED]`.

### Layer 2 — Content scanning (scrubadub + custom regex)

For string values:

```python
_SENSITIVE_TOKEN_PATTERN = (
    r"\b(bearer\s+[a-z0-9._-]+|"
    r"sk-[a-z0-9_-]{8,}|"
    r"gh[pousr]_[a-z0-9_-]{12,}|"
    r"xox[baprs]-[a-z0-9-]{12,})\b"
)
```

The `_SecretTokenDetector` is registered with `scrubadub.Scrubber`. Every string value runs through `Scrubber.clean(...)` and any `{{...}}` placeholders left by scrubadub get further normalized to `[REDACTED]`.

### Layer 3 — Telemetry filtering

OTEL spans with `gen_ai.prompt.*`, `gen_ai.completion.*`, `llm.input_messages.*`, `llm.output_messages.*` attributes are dropped entirely from the noisy-key list — these would otherwise carry full conversation content out to a remote OTEL collector.

### Where redaction happens vs doesn't

| Sink | Redaction applied? |
|---|---|
| `events.jsonl` (local) | ✅ |
| OTEL exporter (Traceloop) | ✅ |
| PostHog events | ✅ (uses sanitizer) |
| LLM context (`messages` sent to provider) | ❌ — the model needs to see what the agent saw |
| Vulnerability report Markdown | ❌ — these are user-visible reports, secrets in PoCs may be intentional |
| Conversation history in process memory | ❌ |

So secrets the model already knew about (e.g. the API key it's testing for exposure) stay in the conversation. Secrets *from the host* (LLM API key, Bearer token) never reach the conversation in the first place.

---

## 11. What Crosses Which Boundary

A consolidated reference for "where does X actually go".

| Datum | Stored on host? | In LLM context? | Sent to LLM provider? | Sent to sandbox? | Persisted to disk? |
|---|:-:|:-:|:-:|:-:|:-:|
| `STRIX_LLM` | ✅ env + config.json | ❌ | ❌ (used as `model` param, not in messages) | ❌ | metadata only |
| `LLM_API_KEY` | ✅ env + config.json | ❌ | ✅ as HTTP Authorization | ❌ | ❌ (sanitizer-redacted) |
| `PERPLEXITY_API_KEY` | ✅ env + config.json | ❌ | ❌ | ❌ | ❌ |
| `sandbox_token` (256-bit) | ✅ in-memory + container env | ❌ | ❌ | ✅ as Bearer | ❌ |
| `--target` values | ✅ args | ✅ system prompt | ✅ (part of system prompt) | ✅ (cloned/mounted) | metadata + report |
| `--instruction` text | ✅ args | ✅ first user message | ✅ | ❌ | ❌ |
| Source code | ✅ tmp + `/workspace` | ❌ (only what tools read) | ❌ except via tool results | ✅ in `/workspace/<subdir>` | ❌ (workspace torn down) |
| Tool kwargs | — | ✅ as the assistant message that emitted them | ✅ | ✅ over HTTPS POST | events.jsonl (sanitized) |
| Tool results | — | ✅ as user message `<tool_result>` | ✅ | — | events.jsonl + reports |
| Conversation history | ✅ in-memory `state.messages` | ✅ entirely | ✅ entirely (after compression) | ❌ | events.jsonl (sanitized) |
| Vulnerability reports | ✅ Tracer.vulnerability_reports | ❌ (separate registry) | only what the reporting agent typed | ❌ | `vulnerabilities/*.md` |
| Caido CA private key | ✅ baked in image (`/app/certs/ca.key`) | ❌ | ❌ | ✅ pre-installed | ❌ |

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — high-level architecture and configuration overview.
- [feature.md](feature.md) — every shipped feature with its config knobs.
- [ToolCall.md](ToolCall.md) — the tool-call transport this document references.
- [multiagent.md](multiagent.md) — per-agent state and inter-agent messaging.
- [Isolation.md](Isolation.md) — what each boundary actually enforces (and what it doesn't).
- [agent-toolcalls.md](agent-toolcalls.md) — per-role tool call patterns.
- [strix/config/config.py](https://github.com/usestrix/strix/blob/main/strix/config/config.py) — `Config` class implementation.
- [strix/telemetry/utils.py](https://github.com/usestrix/strix/blob/main/strix/telemetry/utils.py) — `TelemetrySanitizer`.
- [strix/telemetry/tracer.py](https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py) — persistence & event log.
