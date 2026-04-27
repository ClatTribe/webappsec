# Strix Multi-Agent Orchestration

How Strix runs a graph of cooperating LLM agents inside a single scan: spawn semantics, conversation memory, the per-iteration agent loop, inter-agent messaging, tool dispatch, lifecycle, and how shared state (workspace, proxy, wiki notes) is coordinated.

> **TL;DR.** A scan is a tree of agents rooted at one `StrixAgent`. The root can call `create_agent` to spawn specialist children, each running its own `agent_loop` on its own thread + asyncio event loop, with its own `AgentState` (private conversation history) but **sharing one Docker container, one workspace, one proxy stream, and one process-wide agent graph**. Per-agent isolation is enforced inside the sandbox by an `agent_id` ContextVar that routes terminal/Python/browser sessions. Memory is bounded per agent via [`MemoryCompressor`](https://github.com/usestrix/strix/blob/main/strix/llm/memory_compressor.py); cross-agent knowledge is shared explicitly via inter-agent messages and (for white-box scans) via wiki notes.

---

## Table of Contents

1. [Component Map](#1-component-map)
2. [Agent Lifecycle](#2-agent-lifecycle)
3. [The Agent Loop](#3-the-agent-loop)
4. [Spawning Sub-Agents](#4-spawning-sub-agents)
5. [The Agent Graph](#5-the-agent-graph)
6. [Memory Model](#6-memory-model)
7. [Memory Compression](#7-memory-compression)
8. [Inter-Agent Messaging](#8-inter-agent-messaging)
9. [Tool Dispatch Within the Graph](#9-tool-dispatch-within-the-graph)
10. [Shared State](#10-shared-state)
11. [Stop, Cancel, and Failure Handling](#11-stop-cancel-and-failure-handling)
12. [LLM Stats Aggregation](#12-llm-stats-aggregation)
13. [White-Box Wiki Memory](#13-white-box-wiki-memory)
14. [End-to-End Walkthrough](#14-end-to-end-walkthrough)

---

## 1. Component Map

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Host process (one strix invocation = one scan)                            │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Module-level singletons (the agent graph)                           │  │
│  │  strix/tools/agents_graph/agents_graph_actions.py                    │  │
│  │                                                                       │  │
│  │  _agent_graph        : { nodes: {id → AgentNode}, edges: [...] }     │  │
│  │  _agent_instances    : { id → BaseAgent }                            │  │
│  │  _agent_states       : { id → AgentState }                           │  │
│  │  _agent_messages     : { id → [message, ...] }   (inboxes)           │  │
│  │  _running_agents     : { id → threading.Thread }                     │  │
│  │  _root_agent_id      : str | None                                    │  │
│  │  _completed_agent_llm_totals : rolled-up token/cost stats            │  │
│  │  _agent_llm_stats_lock : threading.Lock                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │ Root Agent   │    │ Sub-Agent A  │    │ Sub-Agent B  │   ...            │
│  │ (asyncio on  │    │ (own thread, │    │ (own thread, │                  │
│  │  main loop)  │    │  own loop)   │    │  own loop)   │                  │
│  │              │    │              │    │              │                  │
│  │  AgentState  │    │  AgentState  │    │  AgentState  │                  │
│  │  LLM         │    │  LLM         │    │  LLM         │                  │
│  │  MemoryComp. │    │  MemoryComp. │    │  MemoryComp. │                  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                  │
│         │ tool calls         │                   │                          │
│         └───────┬────────────┴───────────────────┘                          │
│                 │  HTTP POST /execute                                       │
│                 ▼  (Bearer <sandbox_token>, agent_id in body)               │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Docker sandbox (one container per scan, shared by all agents)       │  │
│  │  FastAPI tool server                                                  │  │
│  │   set_current_agent_id(agent_id) → ContextVar                        │  │
│  │   per-agent terminal panes / IPython kernels / browser tabs          │  │
│  │   shared /workspace, shared Caido proxy                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Files |
|---|---|---|
| **Agent class hierarchy** | The loop, sandbox provisioning, tool dispatch | [strix/agents/base_agent.py](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py), [strix/agents/StrixAgent/](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent) |
| **Agent state** | Per-agent conversation, iteration counter, waiting flags, errors | [strix/agents/state.py](https://github.com/usestrix/strix/blob/main/strix/agents/state.py) |
| **Agent graph** | Cross-agent registry, inboxes, threads, LLM stats roll-up | [strix/tools/agents_graph/agents_graph_actions.py](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py) |
| **LLM wrapper** | Streaming completion, retry, prompt caching, stats, memory compression | [strix/llm/llm.py](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py), [strix/llm/config.py](https://github.com/usestrix/strix/blob/main/strix/llm/config.py) |
| **Memory compressor** | Bounded conversation history per agent | [strix/llm/memory_compressor.py](https://github.com/usestrix/strix/blob/main/strix/llm/memory_compressor.py) |
| **Tool transport** | Local vs sandbox dispatch | [strix/tools/executor.py](https://github.com/usestrix/strix/blob/main/strix/tools/executor.py), [strix/runtime/tool_server.py](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py) |
| **Sandbox session routing** | Per-agent panes/kernels/tabs via ContextVar | [strix/tools/context.py](https://github.com/usestrix/strix/blob/main/strix/tools/context.py), per-tool `*_manager.py` |

---

## 2. Agent Lifecycle

Every agent — root or sub-agent — passes through the same states.

```
                      ┌──────────────┐
                      │  initialised │   __init__: state, llm, register in graph
                      └──────┬───────┘
                             ▼
                      ┌──────────────┐
                      │  running     │   inside agent_loop(), iterating
                      └─┬───┬───┬───┬┘
                        │   │   │   │
            iteration↑  │   │   │   │  no tool call (text response)
                        ▼   │   │   ▼
                  next   ┌──────────────┐
                  iter   │  waiting     │   waiting_for_input flag
                         │  for_input   │
                         └─┬───────┬────┘
                           │       │  message arrives or
                           │       │  waiting_timeout reached
                           ▼       ▼
                      back to running
                             │
                             │  finish_scan / agent_finish / max_iter
                             ▼
                      ┌──────────────┐
                      │  completed   │   final_result set
                      └──────────────┘

      Stop path:    request_stop() → stop_requested flag
                    cancel_current_execution() → in-flight asyncio task cancelled
                    next loop iteration sees should_stop() → completes/waits

      Failure path: SandboxInitializationError → _handle_sandbox_error
                    LLMRequestFailedError       → _handle_llm_error (sets llm_failed)
                    Other RuntimeError          → _handle_iteration_error
                    All persist to state.errors and update agent graph node status.
```

The state-machine lives across two objects:

- [`AgentState`](https://github.com/usestrix/strix/blob/main/strix/agents/state.py) holds the booleans (`completed`, `stop_requested`, `waiting_for_input`, `llm_failed`) and the iteration counter.
- The `_agent_graph["nodes"][agent_id]["status"]` mirror is updated by the loop and by external tools (`stop_agent`, `wait_for_message`, `agent_finish`) so the TUI/CLI can render status.

Status strings actually used: `running`, `waiting`, `waiting_for_input`, `stopping`, `stopped`, `completed`, `failed`, `error`, `llm_failed`, `sandbox_failed`, `finished`.

---

## 3. The Agent Loop

[`BaseAgent.agent_loop(task)`](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py) is a single `while True` that drives one agent. It runs:

```
┌────────────────────────────────────────────────────────────────────────┐
│  await _initialize_sandbox_and_state(task)                             │
│   • root: provisions sandbox, mounts sources                           │
│   • sub-agent: parent already provisioned; reuses sandbox_id/token     │
│   • adds the task as the first user message                            │
└────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
            ┌──── while True ────────────────────────────────┐
            │                                                 │
            │  if _force_stop: cancel + enter waiting state   │
            │                                                 │
            │  _check_agent_messages(state)                   │  drain inbox
            │      → user msg / inter-agent msg appended      │
            │                                                 │
            │  if state.is_waiting_for_input():               │
            │      await _wait_for_input()                    │  poll/timeout
            │      continue                                   │
            │                                                 │
            │  if state.should_stop():                        │
            │      non-interactive → return final_result      │
            │      interactive     → enter waiting state      │
            │                                                 │
            │  if state.llm_failed: wait for input            │
            │                                                 │
            │  state.increment_iteration()                    │
            │  warn at 85% of max_iterations                  │
            │  CRITICAL warn at max_iterations - 3            │
            │                                                 │
            │  await _process_iteration(tracer):              │
            │      messages = state.get_conversation_history │
            │      stream LLM completion                      │
            │      parse <function=…> tool calls              │
            │      _execute_actions(actions)                  │
            │          → process_tool_invocations() (executor)│
            │          → tool runs locally or in sandbox      │
            │          → results appended to history          │
            │      should_finish = (finish_scan/agent_finish) │
            │                                                 │
            │  if should_finish:                              │
            │      non-interactive → set_completed; return    │
            │      interactive     → enter waiting state      │
            │                                                 │
            │  else loop                                      │
            │                                                 │
            └─────────────────────────────────────────────────┘
```

Key behaviors:

- **`max_iterations = 300`** by default. Two reminders are injected as `user` messages: one at 85 % ("approaching limit"), one at `max - 3` ("CRITICAL: 3 iterations left, MUST call finish tool").
- **Empty assistant content correction** — if the model returns empty text and no tools, the loop appends a corrective user message instructing it to call `wait_for_message` / `agent_finish` / `finish_scan`. Prevents infinite no-ops.
- **Cancellation** — `cancel_current_execution()` sets `_force_stop = True` and cancels the in-flight asyncio task (`self._current_task`). The next loop turn enters waiting state instead of dying.
- **Streaming partials on cancel** — if a user cancel arrives mid-LLM-stream, the partial content is recovered from the tracer and appended to history with `[ABORTED BY USER]` so the conversation stays well-formed.

---

## 4. Spawning Sub-Agents

Sub-agents are created by the [`create_agent`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py) tool, callable by any agent (including other sub-agents). The relevant fields:

| Parameter | Purpose |
|---|---|
| `task` | The sub-agent's mandate. |
| `name` | Human-readable identifier shown in the graph and telemetry. |
| `inherit_context` (default `True`) | Whether to seed the sub-agent's history with the parent's conversation. |
| `skills` | Comma-separated skill names (max 5). Validated against `get_all_skill_names()`. |

What `create_agent` does, in order:

1. **Validate skills** with `parse_skill_list` + `validate_requested_skills`.
2. **Inherit LLM config** from the parent: `timeout`, `scan_mode`, `is_whitebox`, `interactive`. Skills are *not* inherited — sub-agents start with only their explicitly requested skills (always plus the `scan_modes/<mode>` skill, plus `coordination/source_aware_whitebox` and `custom/source_aware_sast` for white-box).
3. **Auto-augment task** with white-box guidance if `is_whitebox=True` and the guidance block isn't already present.
4. **Create `AgentState`** with `parent_id = caller.agent_id`, `max_iterations=300`, `waiting_timeout=300` (interactive) or `600` (non-interactive).
5. **Instantiate `StrixAgent(agent_config)`** — registers the agent in `_agent_graph["nodes"]`, `_agent_instances`, `_agent_states`, and adds a `"delegation"` edge from parent to child.
6. **Snapshot inherited messages** if `inherit_context=True` (the parent's full `messages` list at this moment).
7. **Spawn a thread** running [`_run_agent_in_thread`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py):
   - The thread creates **its own asyncio event loop** (`asyncio.new_event_loop()`).
   - Wraps inherited messages in `<inherited_context_from_parent>…</inherited_context_from_parent>` so the sub-agent knows it's reference material, not its own history.
   - Injects an `<agent_delegation>` block stating identity, parent info, and instructions ("you are NOT your parent", "do not merge conversations", etc.).
   - For white-box, calls `_inject_wiki_context_for_whitebox(state)` to add the relevant repo wiki note.
   - Calls `loop.run_until_complete(agent.agent_loop(state.task))`.
   - On normal exit: marks node `completed` (or `stopped` if stop_requested), records result, finalizes LLM stats.
   - On exception: marks node `error`, finalizes stats, re-raises.

Returns immediately — the parent gets `{success, agent_id, message}` and continues its own loop while the child runs concurrently.

### Why threads, not asyncio tasks?

- Each sub-agent's own `agent.agent_loop` makes its own async I/O calls (LiteLLM, httpx) and may call `loop.run_until_complete` internally for memory compression. Running them in separate threads with separate event loops avoids loop-mixing issues.
- The host process is concurrent across agents but each agent's own work is sequential within its loop.
- Threads share Python objects, so `_agent_graph`, `_agent_instances`, `_agent_messages` are all visible to every agent. Thread-safety is provided by `threading.Lock` on the LLM stats map and by the inherent atomicity of dict operations on CPython.

---

## 5. The Agent Graph

The graph is a process-global structure:

```python
_agent_graph: dict[str, Any] = {
    "nodes": {},   # agent_id → AgentNode
    "edges": [],   # delegation + message edges
}
```

### AgentNode shape

```python
{
  "id":           "agent_a1b2c3d4",
  "name":         "Auth Specialist",
  "task":         "...",
  "status":       "running",   # see lifecycle states above
  "parent_id":    "agent_xxxxxxxx" | None,
  "created_at":   "2025-...iso8601...",
  "finished_at":  None | "2025-...",
  "result":       None | { ... },
  "llm_config":   "default",
  "agent_type":   "StrixAgent",
  "state":        AgentState.model_dump(),   # rich snapshot
  "llm_stats":    { input_tokens, output_tokens, cached_tokens, cost, requests },
  "waiting_reason": "..."  # set by wait_for_message
}
```

### Edge types

- `{"from": parent, "to": child, "type": "delegation"}` — added at sub-agent creation.
- `{"from": sender, "to": recipient, "type": "message", "message_id", "message_type", "priority", "created_at"}` — added on every `send_message_to_agent`.

### Tools that read or mutate the graph

| Tool | Purpose |
|---|---|
| `create_agent` | Spawn child, add node + delegation edge |
| `view_agent_graph` | Render a tree view (with "← This is you" marker), summary counts per status |
| `send_message_to_agent` | Append message to recipient's inbox + add message edge |
| `wait_for_message` | Set caller into `waiting` status until inbox has a new message or timeout |
| `agent_finish` | Mark caller `finished`, post a structured `<agent_completion_report>` to parent's inbox |
| `stop_agent` | Request graceful stop on a target agent (sets `stop_requested`, cancels in-flight task) |
| `send_user_message_to_agent` | Used by the TUI/CLI to inject user messages into a specific agent's inbox |

### Root agent

The first agent created has `parent_id=None`. `_root_agent_id` is set to its id and used by the TUI for the "main" tab and by `view_agent_graph` to root the tree. Only the root can call `finish_scan` (the `agent_finish` tool refuses for `parent_id=None` agents).

---

## 6. Memory Model

There is **no shared conversation history**. Each agent owns its `AgentState.messages: list[dict[str, Any]]` and that list is the *only* memory of its own past. What the LLM sees on each iteration is built from that list.

### What's in `state.messages`

| Source | Role | When appended |
|---|---|---|
| Initial task | `user` | `_initialize_sandbox_and_state` |
| For sub-agents: `<inherited_context_from_parent>…</inherited_context_from_parent>` block + parent's snapshot + `<agent_delegation>` block | `user` | `_run_agent_in_thread` |
| Assistant streamed response | `assistant` | `_process_iteration` after the stream completes |
| Tool results (one combined `<tool_result>` block per turn) | `user` | `process_tool_invocations` |
| Inter-agent message arrival | `user` (wrapped in `<inter_agent_message>`) | `_check_agent_messages` |
| User message arrival | `user` | `_check_agent_messages` |
| Iteration warnings | `user` | At 85 % and `max - 3` of `max_iterations` |
| Empty-response correction | `user` | When the model returns no text and no tools |
| White-box wiki context | `user` (wrapped in `<shared_repo_wiki>`) | `_inject_wiki_context_for_whitebox` |
| Self-reflection on cancel | `assistant` | "Execution paused. I'm now waiting…" |

### What's *not* in `state.messages`

- The system prompt — built at every `_prepare_messages` from the agent's loaded skills and tool schemas (see [llm/llm.py](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py)). Not stored on state because skill set can change at runtime.
- Tool execution metadata (latency, exit codes, screenshots beyond text) — those live in the tracer, not the conversation.
- Other agents' histories — strictly off-limits, except via inherited snapshots (one-shot at spawn).

### Inheritance is a snapshot, not a live link

When `create_agent(inherit_context=True)` is called, the parent's `state.get_conversation_history()` is read **once** and copied into the child's first messages. After that, parent and child histories diverge — the child never sees the parent's later turns unless the parent explicitly sends a message via `send_message_to_agent`.

---

## 7. Memory Compression

Conversation history is bounded per agent by [`MemoryCompressor`](https://github.com/usestrix/strix/blob/main/strix/llm/memory_compressor.py), instantiated once per `LLM` (and therefore once per agent):

```python
self.memory_compressor = MemoryCompressor(model_name=config.litellm_model)
```

Compression is applied **on every LLM call**, inside [`_prepare_messages`](https://github.com/usestrix/strix/blob/main/strix/llm/llm.py):

```python
compressed = list(self.memory_compressor.compress_history(conversation_history))
conversation_history.clear()
conversation_history.extend(compressed)
```

So the in-memory `state.messages` is **mutated in place** with the compressed version — the agent's own memory shrinks irreversibly.

### Strategy ([`compress_history`](https://github.com/usestrix/strix/blob/main/strix/llm/memory_compressor.py))

1. **Image budget.** Walk messages from newest to oldest, keep the last 3 images, replace older `image_url` blocks with `[Previously attached image removed to preserve context]`.
2. **Token count.** Sum token estimate (via `litellm.token_counter`) across all messages. If under `MAX_TOTAL_TOKENS * 0.9` (90 k tokens of a 100 k cap), return as-is.
3. **Otherwise summarize.** Split off the last `MIN_RECENT_MESSAGES = 15` messages as untouched recent context; chunk older messages into groups of 10; summarize each chunk via a one-shot LiteLLM call against a security-aware prompt that preserves vulnerabilities, payloads, credentials, version numbers, error messages.
4. **Reassemble.** `system_msgs + summaries + recent_msgs`. Each summary is wrapped in `<context_summary message_count='N'>…</context_summary>`.

### What this guarantees

- The model's context never blows past ~100 k tokens regardless of scan length.
- Recent reasoning is verbatim (15 messages).
- Older reasoning is lossy but topically preserved.
- Failure modes: if the summarization LLM call fails, the chunk's first message is kept as a fallback (degrades gracefully). If `litellm.token_counter` fails, falls back to `len(text) // 4`.

### Per-agent, not global

Each agent compresses its own history independently. There is no organization-wide memory or cross-scan retention — the [roadmap §32](roadmap.md) tracks "org memory" as a future item.

---

## 8. Inter-Agent Messaging

The only sanctioned cross-agent communication channel.

### Sending — `send_message_to_agent`

```python
send_message_to_agent(
    target_agent_id="agent_xxxxxxxx",
    message="…",
    message_type="query"|"instruction"|"information",
    priority="low"|"normal"|"high"|"urgent",
)
```

Effects:

1. Validates target exists in `_agent_graph["nodes"]`.
2. Builds `message_data` with `id = msg_<uuid hex8>`, `from`, `to`, `content`, `message_type`, `priority`, ISO timestamp, `delivered=False`, `read=False`.
3. Appends to `_agent_messages[target_agent_id]`.
4. Adds a `"message"` edge to the graph.
5. Marks `delivered=True`.

The recipient picks up the message on its next loop turn.

### Receiving — `_check_agent_messages` (in [base_agent.py](https://github.com/usestrix/strix/blob/main/strix/agents/base_agent.py))

Called every iteration, before LLM call:

1. Scans `_agent_messages[my_id]` for `read=False` entries.
2. For each message:
   - If sender is `"user"` (i.e. the human user via `send_user_message_to_agent`): adds as a plain `user` message.
   - Otherwise: wraps in an `<inter_agent_message>` XML block carrying sender name + id, message_type, priority, timestamp, content, and a `<delivery_notice>` reminding the recipient *not to echo back* the structure.
   - Marks the message `read=True`.
3. If the agent was in `waiting_for_input` when a message arrived:
   - `llm_failed` agents resume only on user messages.
   - All other agents resume on any message (calls `state.resume_from_waiting()`).
4. Updates the tracer status to `running`.

### Waiting — `wait_for_message`

A tool the agent itself can call to enter `waiting` status. The agent's loop then idles in `_wait_for_input()` until either:

- A new message arrives, or
- `waiting_timeout` elapses (`300 s` interactive, `600 s` non-interactive) — at which point the agent auto-resumes with a "Waiting timeout reached" user message.

### Completion reports — `agent_finish`

When a sub-agent calls `agent_finish`, in addition to marking the node `finished`, it auto-posts a structured XML report to the parent's inbox:

```xml
<agent_completion_report>
    <agent_info>
        <agent_name>…</agent_name>
        <agent_id>…</agent_id>
        <task>…</task>
        <status>SUCCESS|FAILED</status>
        <completion_time>…</completion_time>
    </agent_info>
    <results>
        <summary>…</summary>
        <findings>
            <finding>…</finding>
            …
        </findings>
        <recommendations>
            <recommendation>…</recommendation>
            …
        </recommendations>
    </results>
</agent_completion_report>
```

Priority `high`. The parent's loop sees it like any other inter-agent message.

---

## 9. Tool Dispatch Within the Graph

Tools split cleanly into **graph tools** (host-only, mutate the graph) and **sandbox tools** (forwarded to the container's tool server). See [ToolCall.md](ToolCall.md) for the full transport story.

### Host-only graph tools

Registered with `@register_tool(sandbox_execution=False)`:

| Tool | Effect |
|---|---|
| `create_agent` | Spawns a sub-agent thread |
| `send_message_to_agent` | Posts to inbox |
| `wait_for_message` | Sets agent to `waiting` |
| `agent_finish` | Closes sub-agent, reports up |
| `view_agent_graph` | Renders tree view |
| `finish_scan` | Closes the whole scan (root only) |
| `notes_*`, `todo_*`, `thinking`, `report_vulnerability`, `load_skill`, `web_search` | Various host-side state mutations |

### Per-agent routing inside the sandbox

Sandbox tools (`terminal_execute`, `python_execute`, `browser_*`, `proxy_*`, `file_edit_*`) run inside the shared container, but each agent gets its own session via the `agent_id` ContextVar. The flow:

```
host: _execute_tool_in_sandbox(tool_name, agent_state.sandbox_token, …)
        body includes "agent_id": agent_state.agent_id
              │
              ▼ HTTP /execute
container: tool_server.execute_tool()
        → _run_tool(agent_id, tool_name, kwargs)
            → set_current_agent_id(agent_id)         ← ContextVar
            → tool_func(**kwargs)                     ← reads ContextVar inside
                  └→ TerminalManager._sessions_by_agent[agent_id]
                  └→ PythonManager  ... [agent_id]
                  └→ tab_manager    ... [agent_id]
```

So agent A's `terminal_execute` lands in tmux pane `terminals_by_agent[A][term_id]` and never touches agent B's panes. Same for IPython kernels and Playwright tabs.

### Per-agent task slot in the tool server

[`tool_server.py`](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py) keeps a `dict[agent_id → asyncio.Task]`. A new `/execute` from the same `agent_id` cancels the previous outstanding call from that agent. Cancellation is therefore scoped: aborting agent A's nmap doesn't disturb agent B's running test.

### Validation parallel for all agents

Tool validation (`validate_tool_availability`, `_validate_tool_arguments`) runs on the host before the request crosses the sandbox boundary. Each agent triggers its own validation independently — there's no global rate limit.

---

## 10. Shared State

What is **shared across all agents in a scan**:

| Shared resource | Location | Why shared |
|---|---|---|
| Docker container | one per scan | All agents need access to the same target source / proxy state. |
| `/workspace` directory | inside container | Source files are global; each agent can read what others wrote. |
| Caido HTTP proxy history | inside container | Cross-agent visibility into HTTP traffic is intentional ("you can see proxy traffic from previous work"). |
| `_agent_graph`, `_agent_instances`, `_agent_messages`, `_agent_states` | host process | The orchestration layer itself. |
| `_completed_agent_llm_totals` | host process, lock-guarded | Aggregate token/cost rolled up across all agents. |
| `sandbox_token` | per scan (not per agent) | One token authenticates every agent's tool calls. |
| Wiki notes (white-box) | host-side notes store | Repo knowledge accumulated across the run. |
| Vulnerability reports / dedupe store | host-side | New findings are deduped against all earlier findings in the scan. |

What is **per-agent**:

| Per-agent resource | Mechanism |
|---|---|
| Conversation history | `AgentState.messages` |
| Iteration counter, status flags, errors | `AgentState` |
| LLM client + stats | `BaseAgent.llm` (own `LLM` instance, own `RequestStats`, own `MemoryCompressor`) |
| Active skills / system prompt | `LLMConfig.skills` per agent, rebuilt by `_load_system_prompt` |
| Terminal panes | `TerminalManager._sessions_by_agent[agent_id]` |
| IPython kernels | `PythonManager._kernels_by_agent[agent_id]` |
| Browser tabs | `tab_manager._tabs_by_agent[agent_id]` |
| Inbox | `_agent_messages[agent_id]` |
| Tool-server task slot | `agent_tasks[agent_id]` (only one outstanding call) |

---

## 11. Stop, Cancel, and Failure Handling

Three different shutdown vectors converge on the same machinery.

### User-initiated stop

`stop_agent(agent_id)` (callable from the TUI/CLI):

1. Reads `_agent_states[agent_id]`, calls `state.request_stop()`.
2. Reads `_agent_instances[agent_id]`, calls `agent.cancel_current_execution()`:
   - Sets `_force_stop=True`.
   - Cancels the in-flight `asyncio.Task` (LLM stream, tool execution, memory compression — whichever is current).
3. Marks node `stopping`.
4. Next loop iteration sees `_force_stop` → enters waiting state with cancellation flag set.

### LLM failure

`LLMRequestFailedError` from the `LLM.generate` retry loop (5 retries with exponential backoff up to 90 s):

- Non-interactive: `set_completed({success: False, error})`, mark node `failed`, return.
- Interactive: `enter_waiting_state(llm_failed=True)`, mark node `llm_failed`. Resumes only on a user message (so the user can fix their config and continue).

### Sandbox initialization failure

`SandboxInitializationError` (Docker missing, image pull failed, tool server didn't come up):

- Non-interactive: same as LLM failure, but with status `failed`.
- Interactive: `enter_waiting_state()`, status `sandbox_failed`.

Both errors persist `error` + `details` to the tracer for UI display.

### Iteration exception (RuntimeError/ValueError/TypeError)

`_handle_iteration_error` logs the exception, appends to `state.errors`, marks tracer `error`. Returns whether to continue — interactive agents wait, non-interactive agents propagate.

### Max iterations

`max_iterations = 300`. Two pre-warnings, then `should_stop()` returns `True`. Same routing as user-initiated stop.

---

## 12. LLM Stats Aggregation

Every agent's `LLM` keeps a `RequestStats` accumulator: `input_tokens`, `output_tokens`, `cached_tokens`, `cost`, `requests`. On every completion the stream chunks are passed to `litellm.stream_chunk_builder` and `_update_usage_stats` adds usage + cost to the per-agent stats.

When an agent terminates ([`_finalize_agent_llm_stats`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py)):

1. Snapshot the agent's stats → write into `_agent_graph["nodes"][id]["llm_stats"]`.
2. Add to the lock-guarded `_completed_agent_llm_totals`.
3. Drop the agent from `_agent_instances` so it can be garbage-collected.

The TUI / CLI live stats panel sums:

- `_completed_agent_llm_totals` (already-finished agents)
- Plus `_snapshot_agent_llm_stats(agent)` for every still-running agent in `_agent_instances`.

So the user sees a single per-scan total that updates in real time.

---

## 13. White-Box Wiki Memory

For white-box (source-aware) scans the orchestration adds a shared, persistent knowledge store separate from any agent's conversation: **wiki notes**.

### Mechanism

Wiki notes live in the [notes tool](https://github.com/usestrix/strix/blob/main/strix/tools/notes/notes_actions.py) under the `category="wiki"` namespace. They are tagged with the repo name and contain the agent-curated repo intel (routes, sinks, auth model, observed quirks).

### On sub-agent spawn

[`_inject_wiki_context_for_whitebox`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py):

1. `list_notes(category="wiki")` to find all wiki notes.
2. Walk wiki notes, pick the first one whose tags intersect with the agent's repo tags (extracted from `task` text — `/workspace/<subdir>` paths or `github.com/<org>/<repo>` URLs).
3. Load the note via `get_note(note_id)`.
4. Truncate to 4000 chars.
5. Append to the new agent's history as `<shared_repo_wiki title="…">…</shared_repo_wiki>` user message.

Result: every sub-agent on a white-box scan starts with a brief of what's already known about the repo.

### On sub-agent finish

[`_append_wiki_update_on_finish`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py):

1. Loads the same wiki note.
2. Appends an `## Agent Update: <name> (<timestamp>)` section with the result summary, findings, and recommendations.
3. Best-effort: never blocks `agent_finish` if the note write fails.

The wiki therefore accumulates everything every white-box agent has learned — and is read by the next sub-agent on spawn. This is the closest thing Strix has to organisation memory, and it's scoped to a single scan only.

---

## 14. End-to-End Walkthrough

A minimal trace of a deep scan against `https://github.com/org/app`:

```
1. main.main()
   ├─ parse_arguments, generate run_name, clone repo into workspace
   ├─ pull docker image, validate env, warm up LLM
   └─ run_tui(args) | run_cli(args)

2. run_tui spawns the root StrixAgent
   └─ StrixAgent.__init__:
        AgentState(agent_name="Root Agent", parent_id=None)
        LLMConfig(skills=["root_agent"], scan_mode="deep", is_whitebox=True)
        register in _agent_graph as the root node
        _root_agent_id = self.agent_id

3. StrixAgent.execute_scan(scan_config) → builds task description
   └─ self.agent_loop(task)

4. _initialize_sandbox_and_state(task)
   └─ DockerRuntime.create_sandbox():
        pull/start container, generate token, expose ports
        AgentState.sandbox_id / sandbox_token / sandbox_info populated
   └─ state.add_message("user", task)

5. Iteration 1:
   - LLM streams reasoning + a <function=create_agent> call
   - parse_tool_invocations extracts {toolName, args}
   - _execute_actions → process_tool_invocations
   - create_agent(name="Auth Specialist", task="Test JWT and OAuth", skills="authentication_jwt,business_logic")
       └─ inherits parent history snapshot
       └─ spawns thread #2 with its own event loop
       └─ wiki note injected as <shared_repo_wiki>
   - root continues; child runs concurrently in thread #2

6. Sub-agent (Auth Specialist) iteration 1:
   - Receives <agent_delegation> + inherited context + <shared_repo_wiki>
   - LLM emits <function=terminal_execute><parameter=command>jwt_tool …</parameter></function>
   - _execute_tool_in_sandbox → POST /execute
   - tool_server set_current_agent_id(child_id) → terminal_execute runs in
     TerminalManager._sessions_by_agent[child_id]["default"] (its own tmux pane)
   - result returned, wrapped as <tool_result>, appended to child's history

7. Sub-agent reports a vulnerability:
   - report_vulnerability tool runs locally on host
   - dedupe.py checks against existing reports
   - tracer.log_chat_message + vulnerability_reports list updated
   - TUI renders the new finding card

8. Sub-agent calls agent_finish(success=True, summary=…, findings=[…])
   - node[child_id].status = "finished"
   - <agent_completion_report> posted to root's inbox
   - _append_wiki_update_on_finish appends to wiki
   - _finalize_agent_llm_stats rolls up tokens/cost
   - thread #2 exits

9. Root iteration N (next turn):
   - _check_agent_messages drains inbox; sees the completion report
   - report appended to root's history as <inter_agent_message>
   - LLM observes the result and continues planning

10. After enough iterations, root calls finish_scan
    - StrixAgent.agent_loop returns
    - main.py finally block:
       - tracer.end()
       - posthog.end(exit_reason)
       - DockerRuntime.cleanup() removes the container
    - display_completion_message renders the final panel
    - exit code 2 if vulnerabilities were found in non-interactive mode
```

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — high-level architecture and build instructions.
- [feature.md](feature.md) — every shipped feature in detail.
- [ToolCall.md](ToolCall.md) — the tool-call protocol and transport this document references.
- [Isolation.md](Isolation.md) — the isolation guarantees that constrain what one agent can see of another.
- [roadmap.md](roadmap.md) — gaps including org-level memory (§32), prompt-injection cross-agent defense (§26), and resumable scans (§6).
