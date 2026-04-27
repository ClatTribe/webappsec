# Strix Tool-Call Protocol

How LLM-emitted tool calls are parsed, validated, dispatched, and executed inside Strix — including the relationship between the high-level Python tools and the underlying offensive binaries (nmap, sqlmap, nuclei, …).

> **TL;DR.** Strix does **not** use MCP. The model emits XML in its assistant message; Strix parses it with regex, validates it against an XML schema registered for each tool, and either runs the tool function in-process on the host or forwards it over HTTPS to a FastAPI tool server inside the Docker sandbox. The actual security binaries are invoked by the LLM through the generic `terminal_execute` / `python_execute` tools, not by per-tool wrappers.

---

## Table of Contents

1. [Why not MCP?](#1-why-not-mcp)
2. [End-to-End Flow](#2-end-to-end-flow)
3. [Wire Format](#3-wire-format)
4. [Tool Registry](#4-tool-registry)
5. [Validation](#5-validation)
6. [Local vs. Sandbox Dispatch](#6-local-vs-sandbox-dispatch)
7. [Sandbox Transport](#7-sandbox-transport)
8. [Result Handling](#8-result-handling)
9. [How Security Binaries Are Actually Called](#9-how-security-binaries-are-actually-called)
10. [File Reference](#10-file-reference)
11. [Adding a New Tool](#11-adding-a-new-tool)
12. [MCP Compatibility Path](#12-mcp-compatibility-path)

---

## 1. Why not MCP?

Strix has its own protocol predating most MCP adoption. Concrete reasons it stayed in-tree:

- **Single trust boundary.** Every sandbox-bound call already crosses exactly one authenticated transport (Bearer-token HTTPS to a per-run FastAPI). Layering MCP on top would add a second protocol with no security or capability gain — the client and server are both Strix code deployed together.
- **Long-lived interactive state.** Terminal (tmux pane), Python (IPython kernel), and browser (Playwright tab) tools all maintain state across calls. The protocol passes an `agent_id` so the server routes subsequent calls to the same session.
- **Provider portability.** Tool calls are extracted from plain assistant text with regex, so **any** LiteLLM-supported model works — including local Ollama / LMStudio models that have no MCP-aware adapters and even providers without native function-calling.
- **Tool schemas are baked into the system prompt as XML** (see [`get_tools_prompt()`](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py)), so the model reads the definition in exactly the format it's expected to write.

A future MCP shim is straightforward — see §12.

---

## 2. End-to-End Flow

```
LLM assistant text                                            (any provider via LiteLLM)
   │
   │  <function=terminal_execute>
   │    <parameter=command>nmap -sV target.com</parameter>
   │  </function>
   │
   ▼
parse_tool_invocations()                          strix/llm/utils.py
   │   regex over <function=…> / <parameter=…>
   │   normalizes <invoke name="…"> from Anthropic-style models
   ▼
process_tool_invocations()                        strix/tools/executor.py
   │
   ▼
execute_tool_with_validation()                    strix/tools/executor.py
   │   • validate_tool_availability()  — name in registry?
   │   • _validate_tool_arguments()    — required params present? unknown params?
   │
   ▼
execute_tool()                                    strix/tools/executor.py
   │
   │   should_execute_in_sandbox(tool_name)?
   │   ┌────────────────────┴────────────────────┐
   │   │                                         │
   ▼                                             ▼
_execute_tool_locally()              _execute_tool_in_sandbox()
   │                                             │
   │  in-process call                            │  HTTPS POST → sandbox
   │  (host-side tools:                          │
   │   create_agent, send_agent_message,         │  POST {server_url}/execute
   │   notes, todo, thinking, finish_scan,       │  Authorization: Bearer <sandbox_token>
   │   load_skill, web_search…)                  │  body: {agent_id, tool_name, kwargs}
   │                                             │
   │                                             ▼
   │                              FastAPI tool server in container
   │                              strix/runtime/tool_server.py
   │                                 │  verify_token()
   │                                 │  set_current_agent_id()
   │                                 │  asyncio.to_thread(tool_func, **kwargs)
   │                                 │  with hard wait_for() timeout
   │                                 │
   │                                 ▼
   │                              registered tool function
   │                              e.g. terminal_actions.terminal_execute
   │                                 │
   │                                 │  drives libtmux / playwright / caido / IPython
   │                                 │  which in turn invoke nmap, sqlmap, nuclei, …
   │                                 │
   │                                 ▼
   │                              {result: …} or {error: …}
   │                                             │
   ▼                                             ▼
result wrapped in <tool_result>…</tool_result> XML and appended to conversation history
```

---

## 3. Wire Format

### Assistant → Strix

The LLM emits one or more XML blocks anywhere in the assistant message:

```xml
<function=tool_name>
  <parameter=param1>value1</parameter>
  <parameter=param2>value2</parameter>
</function>
```

Anthropic-style alternatives are normalized to the canonical form by `normalize_tool_format`:

```xml
<invoke name="tool_name">
  <parameter name="param1">value1</parameter>
</invoke>
```

→ rewritten internally to `<function=tool_name>` + `<parameter=param1>`.

Parsed shape (Python):

```python
[
  {"toolName": "terminal_execute", "args": {"command": "nmap -sV target.com"}},
  …
]
```

`fix_incomplete_tool_call` patches truncated streams (e.g. when the model gets cut off mid-XML) by appending the missing `</function>`.

### Strix → Assistant

Each tool response is appended to the conversation as a user message:

```xml
<tool_result>
  <tool_name>terminal_execute</tool_name>
  <result>… string or JSON-stringified payload, truncated to ~10k chars …</result>
</tool_result>
```

Screenshots are extracted from the result and attached as image content blocks instead of being inlined as base64 — see `extract_screenshot_from_result` / `remove_screenshot_from_result`.

---

## 4. Tool Registry

Tools register themselves at import time via [`@register_tool`](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py):

```python
from strix.tools.registry import register_tool

@register_tool                     # sandbox_execution=True by default
def terminal_execute(command: str, …) -> dict[str, Any]:
    …

@register_tool(sandbox_execution=False)   # runs on the host
def create_agent(task: str, name: str, skills: str = "") -> dict[str, Any]:
    …

@register_tool(requires_browser_mode=True)
def browser_navigate(url: str) -> dict[str, Any]:
    …

@register_tool(requires_web_search_mode=True)
def web_search(query: str) -> dict[str, Any]:
    …
```

What the decorator does:

| Behavior | Source |
|---|---|
| Records the function in `_tools_by_name` and the global `tools` list | `register_tool` in [registry.py](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py) |
| Loads the matching `<name>_actions_schema.xml` from the same folder | `_get_schema_path` + `_load_xml_schema` |
| Parses the XML's `<parameters>` block to derive required/optional/known params for validation | `_parse_param_schema` |
| Skips registration when a capability is missing (`requires_browser_mode` + `STRIX_DISABLE_BROWSER=true`, or `requires_web_search_mode` without `PERPLEXITY_API_KEY`) | `_should_register_tool` |
| Skips registration on the host side for sandbox-only tools when running **inside** the sandbox, and vice versa | same |
| Substitutes the dynamic placeholder `{{DYNAMIC_SKILLS_DESCRIPTION}}` in `load_skill_actions_schema.xml` with the live skill list | `_process_dynamic_content` |

The XML schemas serve a dual purpose:

1. **Validation source of truth** — `_parse_param_schema` derives `params` and `required` sets from `<parameter required="true">` attributes.
2. **Prompt content** — `get_tools_prompt()` concatenates every tool's XML grouped by module (`<browser_tools>…</browser_tools>`, `<terminal_tools>…</terminal_tools>`, …) and injects the result into the agent's system prompt so the model knows exactly how to call each one.

---

## 5. Validation

`execute_tool_with_validation` runs two checks before dispatch:

```python
# 1. Is the tool registered for this side (host vs. sandbox)?
validate_tool_availability(tool_name)

# 2. Do the kwargs match the XML schema?
_validate_tool_arguments(tool_name, kwargs)
#    • Reject unknown params  → "received unknown parameter(s): foo"
#    • Reject missing required params → "missing required parameter(s): bar"
#    • Both errors include a schema hint listing the valid params
```

Validation failures are returned as `"Error: …"` strings (not exceptions) so the LLM can see them in the next turn and self-correct without breaking the loop.

After validation, `convert_arguments` ([argument_parser.py](https://github.com/usestrix/strix/blob/main/strix/tools/argument_parser.py)) coerces the string-typed XML params to the function's actual annotated Python types using `inspect.signature` — so `<parameter=timeout>30</parameter>` becomes `timeout: float = 30.0`.

---

## 6. Local vs. Sandbox Dispatch

Each tool is flagged at registration with `sandbox_execution: bool` (default `True`). The dispatcher picks the path:

```python
async def execute_tool(tool_name, agent_state, **kwargs):
    if should_execute_in_sandbox(tool_name) and not STRIX_SANDBOX_MODE:
        return await _execute_tool_in_sandbox(tool_name, agent_state, **kwargs)
    return await _execute_tool_locally(tool_name, agent_state, **kwargs)
```

| Path | When | Examples |
|---|---|---|
| **Local** (in-process, on the host) | `sandbox_execution=False`, or already inside the container | `create_agent`, `send_agent_message`, `wait_for_message`, `notes_*`, `todo_*`, `thinking`, `finish_scan`, `agent_finish`, `load_skill`, `web_search`, `report_vulnerability` |
| **Sandbox** (HTTP forward) | `sandbox_execution=True` and host process | `terminal_execute`, `python_execute`, `browser_*`, `proxy_*`, `file_edit_*` |

The same registered function runs in both contexts. The container has a flag `STRIX_SANDBOX_MODE=true` so when `_execute_tool_locally` runs there, it skips the HTTP forward and just calls the function directly.

---

## 7. Sandbox Transport

### Host side — `_execute_tool_in_sandbox`

```python
runtime = get_runtime()                                                # DockerRuntime
server_url = await runtime.get_sandbox_url(sandbox_id, tool_server_port)
request = {
    "agent_id":   agent_state.agent_id,
    "tool_name":  tool_name,
    "kwargs":     kwargs,
}
headers = {"Authorization": f"Bearer {agent_state.sandbox_token}"}
async with httpx.AsyncClient(trust_env=False) as client:
    response = await client.post(f"{server_url}/execute",
                                 json=request, headers=headers,
                                 timeout=httpx.Timeout(SANDBOX_EXECUTION_TIMEOUT,
                                                       connect=SANDBOX_CONNECT_TIMEOUT))
```

Timeouts:

- `STRIX_SANDBOX_EXECUTION_TIMEOUT` — server-side hard cap (default 120 s).
- Client-side `SANDBOX_EXECUTION_TIMEOUT = server_timeout + 30` to give the server a chance to respond with its own timeout error first.
- `STRIX_SANDBOX_CONNECT_TIMEOUT` — TCP connect cap (default 10 s).

### Container side — [tool_server.py](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py)

A FastAPI app started by the container entrypoint:

```python
@app.post("/execute", response_model=ToolExecutionResponse)
async def execute_tool(request, credentials):
    verify_token(credentials)
    if request.agent_id in agent_tasks:               # cancel older outstanding call
        agent_tasks[request.agent_id].cancel()
    task = asyncio.create_task(
        asyncio.wait_for(_run_tool(...), timeout=REQUEST_TIMEOUT))
    agent_tasks[request.agent_id] = task
    return await task
```

Notes:

- **Per-agent task slot.** A new request from the same `agent_id` cancels the previous one — important when the user hits Ctrl-C in the TUI to abort a long `nmap`.
- **Hard timeout** via `asyncio.wait_for`.
- Errors are returned as `{"error": "…"}` JSON, never as 5xx, so the host doesn't need to disambiguate transport vs. tool failure.
- `/health` is used by `DockerRuntime._wait_for_tool_server` after container start.
- `/register_agent` is reserved for future use; not currently used in dispatch.

---

## 8. Result Handling

`process_tool_invocations` aggregates per-call results back into the conversation:

1. Each result is wrapped in `<tool_result><tool_name>…</tool_name><result>…</result></tool_result>`.
2. Result strings longer than 10 k chars are middle-truncated (`first_4k + "[truncated]" + last_4k`) so the model still sees both ends.
3. Screenshots (browser tool) are extracted and re-attached as image content blocks rather than inlined as base64 — saves tokens and lets vision-capable models actually look at them.
4. The combined block is appended as a `user`-role message, not `tool` — Strix emulates tool-result delivery via a regular user turn so it works with models that don't have a native `tool` role.
5. `finish_scan` and `agent_finish` set the loop's `should_agent_finish` flag based on their result payload.

The tracer (`strix/telemetry/tracer.py`) records every tool execution start/end with `log_tool_execution_start` / `update_tool_execution`, which feeds the TUI / CLI live view and the persisted scan artifacts.

---

## 9. How Security Binaries Are Actually Called

A common point of confusion: **there is no per-tool Python wrapper for nmap, sqlmap, nuclei, etc.** They are not registered tools. Instead, the LLM uses the generic execution tools, and the binaries are invoked as plain shell commands inside the sandbox.

| Underlying tech | Strix tool exposed to the LLM | What it actually drives |
|---|---|---|
| **tmux + pyte + libtmux** | `terminal_execute` | A real `tmux` pane in the sandbox. The LLM types shell commands; the rendered screen comes back as text. This is how `nmap`, `sqlmap`, `nuclei`, `ffuf`, `httpx`, `subfinder`, `naabu`, `katana`, `semgrep`, `bandit`, `trufflehog`, `gitleaks`, `trivy`, `zaproxy`, `wapiti`, `arjun`, `dirsearch`, `wafw00f`, `jwt_tool`, `interactsh-client`, `vulnx`, `gospider`, `retire.js`, `ast-grep`, `tree-sitter`, etc. all run. |
| **IPython kernel** | `python_execute` | A persistent IPython process in the sandbox for ad-hoc Python — payload crafting, JWT decoding, hash computation, requests-based PoCs. State persists across calls. |
| **Playwright (Chromium)** | `browser_*` (navigate, click, fill, screenshot, eval, …) | A headless Chromium driven by Playwright. Multi-tab via `tab_manager.py`. Used for XSS, CSRF, auth flows, DOM analysis. |
| **Caido CLI** | `proxy_*` | Talks to the Caido MITM proxy (port 48080 in the sandbox). Lists/replays/modifies intercepted requests. The container's root CA is trusted system-wide so HTTPS interception is transparent. |
| **openhands-aci** | `file_edit_*` | Safe patch/edit on workspace files. |

The skill packs in [`strix/skills/tooling/`](https://github.com/usestrix/strix/blob/main/strix/skills/tooling) (`nmap.md`, `sqlmap.md`, `nuclei.md`, `httpx.md`, `ffuf.md`, `naabu.md`, `katana.md`, `subfinder.md`, `semgrep.md`) are **Markdown playbooks** that get injected into the agent's system prompt when loaded via `load_skill`. They tell the LLM the right command lines, flags, and validation steps for each binary — but the binary itself is invoked through `terminal_execute` like any other shell command.

This matters for two reasons:

1. **Adding a new offensive tool means installing it in the [Dockerfile](https://github.com/usestrix/strix/blob/main/containers/Dockerfile)** and (optionally) writing a skill playbook. There is **no Python glue code to write**, no schema, no argument-parsing — the LLM drives the CLI directly.
2. **The agent has the full power of a Kali shell**, not a curated subset. It can pipe, grep, re-shell, install missing utilities (`pipx install …`, `go install …`), or compile a one-off C exploit if it needs to.

---

## 10. File Reference

| File | Role |
|---|---|
| [strix/llm/utils.py](https://github.com/usestrix/strix/blob/main/strix/llm/utils.py) | `parse_tool_invocations`, `normalize_tool_format`, `fix_incomplete_tool_call` — extracts tool calls from assistant text |
| [strix/tools/registry.py](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py) | `@register_tool`, schema loading, `get_tools_prompt`, `should_execute_in_sandbox`, conditional registration |
| [strix/tools/argument_parser.py](https://github.com/usestrix/strix/blob/main/strix/tools/argument_parser.py) | `convert_arguments` — type coercion via `inspect.signature` |
| [strix/tools/executor.py](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py) | `execute_tool`, `_execute_tool_in_sandbox`, `_execute_tool_locally`, `process_tool_invocations`, result wrapping |
| [strix/tools/context.py](https://github.com/usestrix/strix/blob/main/strix/tools/context.py) | `set_current_agent_id` — context var so sandbox-side tools know which agent called them |
| [strix/runtime/runtime.py](https://github.com/usestrix/strix/blob/main/strix/runtime/runtime.py) | `AbstractRuntime` interface |
| [strix/runtime/docker_runtime.py](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) | `DockerRuntime` — pulls image, picks ports, mounts workspace, generates auth token, starts container |
| [strix/runtime/tool_server.py](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py) | FastAPI tool server inside the sandbox; `/execute`, `/health`, `/register_agent` |
| [strix/agents/base_agent.py](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py) | `_execute_actions` — calls `process_tool_invocations` from the agent loop |
| [strix/tools/<name>/<name>_actions.py](https://github.com/usestrix/strix/blob/main/strix/tools) | Per-module tool implementations |
| [strix/tools/<name>/<name>_actions_schema.xml](https://github.com/usestrix/strix/blob/main/strix/tools) | Per-module XML schemas (validation + prompt content) |

---

## 11. Adding a New Tool

1. **Create the module folder.** `strix/tools/myfeature/`
2. **Implement the function** in `myfeature_actions.py`:
   ```python
   from strix.tools.registry import register_tool

   @register_tool(sandbox_execution=True)        # set False to run on the host
   def myfeature_do_thing(target: str, depth: int = 3) -> dict[str, Any]:
       …
       return {"status": "ok", "findings": [...]}
   ```
3. **Write the XML schema** at `myfeature_actions_schema.xml`:
   ```xml
   <tool name="myfeature_do_thing">
     <description>What the tool does, when to use it.</description>
     <parameters>
       <parameter name="target" type="string" required="true">
         The target URL or path.
       </parameter>
       <parameter name="depth" type="integer">
         Recursion depth (default 3).
       </parameter>
     </parameters>
   </tool>
   ```
4. **Add `from . import myfeature_actions`** in `strix/tools/__init__.py` so the module is imported on package load and the decorator runs.
5. **Tests:** mirror under `tests/tools/myfeature/`. The package's existing tests show the expected style.

The new tool shows up in the prompt automatically, validated automatically, and routed automatically based on `sandbox_execution`.

For an offensive CLI binary, **don't** wrap it as a tool — install it in the [Dockerfile](https://github.com/usestrix/strix/blob/main/containers/Dockerfile) and (optionally) write a skill playbook in `strix/skills/tooling/<bin>.md`. The LLM will call it through `terminal_execute`.

---

## 12. MCP Compatibility Path

Adding MCP support is a thin shim because the dispatch layer is already protocol-agnostic:

1. Spin up an MCP server (e.g. with `mcp` SDK) inside the host process.
2. On `tools/list`, enumerate `_tools_by_name` from [registry.py](https://github.com/usestrix/strix/blob/main/strix/tools/registry.py) and translate each `xml_schema` to a JSON Schema (the `<parameter>` elements already carry `name`, `type`, and `required`).
3. On `tools/call`, build a `tool_inv = {"toolName": name, "args": args}` and call the existing [`execute_tool_with_validation`](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py).
4. Surface streamed tool output via MCP progress notifications.

The hardest part is reproducing the per-agent session model — Strix's transport carries `agent_id` so terminal/Python/browser state is routed to the right pane/kernel/tab. An MCP client would need to either pass an equivalent session id or accept that each MCP client gets a separate sandbox session.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — project overview, architecture, build.
- [feature.md](feature.md) — every feature in detail (tools, runtime, skills, etc.).
- [roadmap.md](roadmap.md) — gaps and priorities.
- [strix/skills/README.md](https://github.com/usestrix/strix/blob/main/strix/skills/README.md) — authoring skill playbooks (which is how new offensive tooling typically lands).
