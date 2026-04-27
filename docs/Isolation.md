# Strix Isolation Model

How Strix isolates state between scans, between agents inside one scan, between the sandbox and the host, and between OS users — with the actual code paths that enforce each boundary and the failure modes that exist today.

> **TL;DR.** Strix is **strong on run-↔-run isolation** (fresh Docker container, fresh ports, fresh 256-bit auth token, forced teardown), **logical-only on agent-↔-agent isolation within a run** (shared container and `/workspace`, separated only by an `agent_id` context var), **standard Docker on sandbox-↔-host isolation** (unprivileged user, no Docker socket, source copied not bind-mounted, but unrestricted egress), and **not designed for multi-tenant** OS users.

---

## Table of Contents

1. [The Four Boundaries](#1-the-four-boundaries)
2. [Boundary A — Run ↔ Run](#2-boundary-a--run--run-strong)
3. [Boundary B — Agent ↔ Agent (within a run)](#3-boundary-b--agent--agent-within-a-run-logical-only)
4. [Boundary C — Sandbox ↔ Host](#4-boundary-c--sandbox--host-standard-docker)
5. [Boundary D — User ↔ User (multi-tenant)](#5-boundary-d--user--user-multi-tenant-not-designed-for)
6. [Cleanup & Teardown](#6-cleanup--teardown)
7. [Auth Token Lifecycle](#7-auth-token-lifecycle)
8. [Filesystem & Workspace Layout](#8-filesystem--workspace-layout)
9. [Network Posture](#9-network-posture)
10. [Known Gaps & Failure Modes](#10-known-gaps--failure-modes)
11. [Hardening Recommendations](#11-hardening-recommendations)

---

## 1. The Four Boundaries

| Boundary | Mechanism | Strength |
|---|---|---|
| **Run ↔ Run** | Fresh container, fresh ports, fresh 256-bit token, force-remove on collision, full teardown on exit | **Strong** |
| **Agent ↔ Agent** (same run) | `agent_id` ContextVar routing per pane / kernel / tab; per-agent task slot; per-agent state | **Logical, not enforced** — agents share `/workspace`, proxy state, agent graph |
| **Sandbox ↔ Host** | Unprivileged container user, no Docker socket, source copied not bind-mounted | **Standard Docker** with extra net caps; no egress firewall |
| **User ↔ User** | None (single-tenant CLI) | **Not isolated** beyond OS-level Docker group |

The rest of this document expands each row with the actual code that enforces it.

---

## 2. Boundary A — Run ↔ Run (strong)

Each `strix --target …` invocation is a separate scan and is isolated from every other scan by a combination of unique identifiers, an isolated Docker container, and randomized auth.

### Unique identifiers per run

| Identifier | Source | What it scopes |
|---|---|---|
| `run_name` = `<slugified-target>_<token_hex(2)>` | [`generate_run_name`](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py) | Output dir `strix_runs/<run-name>/`, repo clone dir `<tmp>/strix_repos/<run-name>/` |
| `scan_id` (from tracer scan_config or fallback) | [`_get_scan_id`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) | Container name `strix-scan-{scan_id}` |
| Random tool-server port | `_find_available_port()` | Host ↔ container HTTP transport |
| Random Caido port | `_find_available_port()` | Caido proxy UI |
| `secrets.token_urlsafe(32)` (256 bits) | `_create_container` | Bearer auth on every tool call |

### Fresh container per scan

[`_create_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) does, in order:

1. `client.containers.get(container_name)` — if a container with the target name already exists, **stop and force-remove** it (`existing.remove(force=True)`). This is what guarantees no state from a previous scan with the same name leaks in.
2. Pick fresh host ports.
3. Generate fresh `_tool_server_token`.
4. `client.containers.run(image_name, command="sleep infinity", detach=True, …)`. The image is read-only; the container gets its own writable overlay.
5. `_wait_for_tool_server()` polls `/health` until ready.

Because the image is immutable and each container has its own overlay filesystem, **filesystem changes from one scan never appear in another**.

### Container teardown

[`cleanup()`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) is registered as the runtime exit hook. It detaches a `docker rm -f <container-name>` subprocess so even a Ctrl-C'd or crashed scan removes its container. [`destroy_sandbox(container_id)`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) does the same explicitly when called.

### What is *not* re-isolated across runs

- `~/.strix/cli-config.json` — LLM API keys and telemetry settings persist across runs (intentional, for UX).
- The Docker image `ghcr.io/usestrix/strix-sandbox` and its baked-in CA private key (see §10).
- `~/.strix/bin/strix` — the binary itself.

---

## 3. Boundary B — Agent ↔ Agent (within a run) (logical only)

When the root `StrixAgent` calls `create_agent(...)`, the new sub-agent **does not get its own container**. All agents in one scan share the same Docker container, the same `/workspace`, and the same `sandbox_token`. Per-agent isolation is layered on top with an `agent_id` context variable.

### `agent_id` ContextVar — the routing key

[`strix/tools/context.py`](https://github.com/usestrix/strix/blob/main/strix/tools/context.py) defines a single `ContextVar`:

```python
current_agent_id: ContextVar[str] = ContextVar("current_agent_id", default="default")
```

Inside the sandbox, [`_run_tool`](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py) calls `set_current_agent_id(agent_id)` **before** invoking the tool function. Every per-agent state manager reads it back via `get_current_agent_id()` to look up the right session.

### Per-agent session managers

| Manager | File | What it isolates |
|---|---|---|
| `TerminalManager._sessions_by_agent[agent_id]` | [terminal_manager.py](https://github.com/usestrix/strix/blob/main/strix/tools/terminal/terminal_manager.py) | tmux panes — agent A's `terminal_execute` cannot see or write agent B's pane |
| `PythonManager` (same pattern) | [python_manager.py](https://github.com/usestrix/strix/blob/main/strix/tools/python/python_manager.py) | IPython kernels — variables don't leak across agents |
| Browser `tab_manager` | [tab_manager.py](https://github.com/usestrix/strix/blob/main/strix/tools/browser/tab_manager.py) | Per-agent Playwright tabs |
| `agent_tasks` slot in tool server | [tool_server.py](https://github.com/usestrix/strix/blob/main/strix/runtime/tool_server.py) | At most one outstanding tool call per `agent_id`; second concurrent call from same agent cancels the first (used by Ctrl-C abort) |

All maps are guarded by `threading.Lock` to prevent races when a sub-agent is created concurrently with an in-flight call.

### Per-agent state on the host

[`AgentState`](https://github.com/usestrix/strix/blob/main/strix/agents/state.py) is per-agent. Conversation history, messages, todo, notes are owned by that agent's instance and not leaked into another agent's `state.messages`.

### What agents within a run *can* see from each other

This is what makes the boundary logical rather than enforced:

- **`/workspace`** — every agent can read and write the same target source tree. No per-agent subdirectories.
- **Caido proxy history** — global to the container, every agent's `proxy_*` calls see the same captured stream.
- **Inter-agent messaging** — `send_agent_message` / `wait_for_message` mutate a shared `_agent_messages: dict[agent_id, list[message]]` in [`agents_graph_actions.py`](https://github.com/usestrix/strix/blob/main/strix/tools/agents_graph/agents_graph_actions.py). This is the explicit cross-agent channel.
- **`_agent_graph["nodes"]`** — a global mutable structure on the host process holding all agents' status and rolled-up LLM stats.
- **Outbound network posture** — there is no per-agent egress policy.

> **Implication.** A compromised sub-agent (e.g. via prompt injection from scraped attacker-controlled content) could, in principle, drive its `terminal_execute` to read another agent's transcripts off the host or trample another agent's workspace files. Nothing inside the container *prevents* it — agents are separated by the model's behavior, not by OS-level enforcement.

---

## 4. Boundary C — Sandbox ↔ Host (standard Docker)

### Container privileges

Set in [`_create_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py):

```python
self.client.containers.run(
    image_name,
    command="sleep infinity",
    detach=True,
    name=container_name,
    hostname=container_name,
    ports={
        f"{CONTAINER_TOOL_SERVER_PORT}/tcp": self._tool_server_port,
        f"{CONTAINER_CAIDO_PORT}/tcp": self._caido_port,
    },
    cap_add=["NET_ADMIN", "NET_RAW"],         # ← extra capabilities for nmap
    labels={"strix-scan-id": scan_id},
    environment={
        "PYTHONUNBUFFERED": "1",
        "TOOL_SERVER_PORT": str(CONTAINER_TOOL_SERVER_PORT),
        "TOOL_SERVER_TOKEN": self._tool_server_token,
        "STRIX_SANDBOX_EXECUTION_TIMEOUT": str(execution_timeout),
        "HOST_GATEWAY": HOST_GATEWAY_HOSTNAME,
    },
    extra_hosts={HOST_GATEWAY_HOSTNAME: "host-gateway"},
    tty=True,
)
```

| Aspect | Setting | Implication |
|---|---|---|
| Container user | `pentester` (passwordless sudo **inside** the container only — see [Dockerfile](https://github.com/usestrix/strix/blob/main/containers/Dockerfile)) | Sudo doesn't cross the container boundary. |
| `--privileged` | **No** | Standard Docker privilege set + the two extra caps. |
| `cap_add` | `NET_ADMIN`, `NET_RAW` | Needed for `nmap` raw-socket scans. Wider than a default container. |
| Docker socket | **Not mounted** | Sandbox cannot drive the Docker daemon. |
| `--security-opt no-new-privileges` | **Not set** | A future hardening item. |
| `seccomp` / `apparmor` | Docker defaults only | No custom profile shipped. |

### Workspace handling — copy, not bind-mount

[`_copy_local_directory_to_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) tar-streams local source paths into the container with `container.put_archive("/workspace", …)` and chowns to `pentester:pentester`. There is **no host bind-mount** by default — the user's source tree on disk is **not** writable from the sandbox. An agent that "edits" a file is editing the in-container copy.

(Consequence: if you want fixes to land in your local checkout, you currently have to extract them — Strix's autofix path lives on the SaaS side.)

### Network ingress

`_resolve_docker_host()` returns `127.0.0.1` unless `DOCKER_HOST` is remote. The tool-server and Caido ports therefore bind only to localhost in the default setup — but every other process running as the same OS user can reach them. The Bearer token is the only thing keeping them out.

### Network egress

The container has unrestricted outbound network access — public internet, plus the host via `host.docker.internal` (mapped via `extra_hosts`). Strix relies on the agent staying within the user-authorized targets passed to `--target`. There is **no L4 firewall** enforcing that constraint at runtime — this is one of the gaps tracked in [roadmap.md §26](roadmap.md).

### Transport security

- Plaintext HTTP over loopback between host and the tool server (no TLS, since both ends are on `127.0.0.1`).
- `verify_token` uses plain `!=` comparison instead of `secrets.compare_digest` — see §10.
- If `DOCKER_HOST=tcp://…` points at a remote daemon, tool I/O and the Bearer token traverse that network **unencrypted** unless the user tunnels it themselves.

---

## 5. Boundary D — User ↔ User (multi-tenant) (not designed for)

Strix is a **single-user CLI**. There is no concept of user identity, scan ownership, RBAC, or audit log.

- `~/.strix/cli-config.json` is per OS user.
- `strix_runs/<run-name>/` is per CWD.
- Two OS users on the same host running `strix` simultaneously each get their own `DockerRuntime` instance with distinct containers, ports, and tokens — **only if their `scan_id`s differ** (in practice they will, because scan_ids come from a tracer UUID).
- They share the Docker daemon. Either user with `docker` group access can `docker exec` into the other's strix container — that's a Docker host policy concern, not a Strix property.

True multi-tenant isolation (RBAC, audit log, scan-ownership scoping, per-tenant secrets vault) is the [roadmap §25](roadmap.md) item.

---

## 6. Cleanup & Teardown

The sandbox lifecycle is built so that **a crashed or interrupted scan still cleans up its container**:

| Trigger | Path | Behavior |
|---|---|---|
| Normal completion (`finish_scan`) | `main()` finally block + `cleanup()` | Stops & removes the container. |
| Ctrl-C (KeyboardInterrupt) | Same `finally` runs in [strix/interface/main.py](https://github.com/usestrix/strix/blob/main/strix/interface/main.py) | Detached `docker rm -f` so removal continues even if Python exits. |
| Crash (unhandled exception) | Same `finally`; PostHog `error()` logs the cause | Container is removed. |
| OS kill -9 | Container is **not** removed by Strix itself | Next run with the same `scan_id` would force-remove it on collision. Otherwise it stays as `strix-scan-<id>` until manually removed. |
| Container created mid-run, scan stopped | Tool server's `signal_handler` cancels in-flight `agent_tasks` and exits | The host then issues `docker rm -f` via `cleanup()`. |

In addition, [`_get_or_create_container`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py) supports **resume** within the same `scan_id`: if the container already exists, ports, token, and Caido state are recovered from the running container's metadata via [`_recover_container_state`](https://github.com/usestrix/strix/blob/main/strix/runtime/docker_runtime.py).

---

## 7. Auth Token Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│  Host (DockerRuntime)                                            │
│                                                                   │
│  _create_container():                                            │
│    self._tool_server_token = secrets.token_urlsafe(32)           │
│        │                                                          │
│        │   passed as ENV inside the container:                   │
│        │     TOOL_SERVER_TOKEN=<token>                           │
│        ▼                                                          │
│  create_sandbox() returns SandboxInfo {                           │
│    "auth_token": token,                                           │
│    …                                                              │
│  }                                                                │
│        │                                                          │
│        │   stored on AgentState.sandbox_token                    │
│        ▼                                                          │
│  every _execute_tool_in_sandbox() call sets:                      │
│    Authorization: Bearer <agent_state.sandbox_token>             │
└──────────────────────────────────────────────────────────────────┘
                              │  HTTP POST /execute
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Container (FastAPI tool server)                                 │
│                                                                   │
│  uvicorn started with --token <token-from-ENV>                   │
│  EXPECTED_TOKEN = args.token                                     │
│                                                                   │
│  verify_token(credentials):                                      │
│    if credentials.scheme != "Bearer": 401                        │
│    if credentials.credentials != EXPECTED_TOKEN: 401             │
└──────────────────────────────────────────────────────────────────┘
```

- **Entropy.** `secrets.token_urlsafe(32)` ≈ 256 bits.
- **Lifetime.** A single token for the full scan, used by every agent in the agent graph.
- **Comparison.** Plain `!=` (not constant-time). Practically not exploitable, but trivial to fix.
- **Distribution.** Token is generated on the host, written into the container as `TOOL_SERVER_TOKEN`, and surfaced back to the host as `auth_token`. It never traverses the LLM context.

---

## 8. Filesystem & Workspace Layout

| Path | Where | Lifetime | Shared between… |
|---|---|---|---|
| `strix_runs/<run-name>/` | Host CWD | Persists after scan | Nothing — per run output. |
| `<tmpdir>/strix_repos/<run-name>/` | Host tmp | Persists until OS tmp cleanup | Nothing — per run repo clones. |
| `~/.strix/bin/` | Host user home | Across runs | Same OS user only. |
| `~/.strix/cli-config.json` (mode 0600) | Host user home | Across runs | Same OS user only. |
| `/workspace/<subdir>` | Container | Container lifetime | **All agents in the run.** |
| `/home/pentester/{tools,wordlists,output,scripts}` | Container | Container lifetime | All agents (image-baked, read mostly). |
| `/app/certs/{ca.crt,ca.key,ca.p12}` | Container | Image lifetime | **All scans of this image** (see §10). |
| `/tmp/caido_startup.log` | Container | Container lifetime | All agents. |

The key boundary to internalise: **`/workspace` is shared across all agents in a scan**, and the container is fresh per scan. There is no per-agent filesystem segregation inside the container.

---

## 9. Network Posture

Default network behavior:

- **Egress:** unrestricted. The container can reach the public internet. Strix relies on the model honoring the authorized target list. No iptables/nftables rules are installed by default.
- **Host access:** the `host.docker.internal` extra host points at the Docker host gateway, which lets the agent test a dev server running on the user's laptop. This is a feature for `localhost` rewriting in [`rewrite_localhost_targets`](https://github.com/usestrix/strix/blob/main/strix/interface/utils.py) but is also a vector for accidental host-network probing.
- **Ingress (host → sandbox):** the tool-server and Caido ports are bound on the host. By default `_resolve_docker_host()` returns `127.0.0.1`. Anyone on the host running as the same user can reach the ports — but needs the per-scan Bearer token.
- **Caido CA:** generated **at image build time** and burned into the image (see [Dockerfile](https://github.com/usestrix/strix/blob/main/containers/Dockerfile)). Every container instance from the same image trusts the same CA — see §10.

---

## 10. Known Gaps & Failure Modes

These are real, observable behaviors in the current code — listed bluntly so they can be triaged and tracked.

1. **`scan_id` collision is destructive.** If two simultaneous runs end up with the same `scan_id`, the second's `_create_container` calls `existing.remove(force=True)` on the first's container. Practical risk is low (scan_ids are UUIDs from the tracer), but the failure is silent and destructive rather than abortive.

2. **Prompt-injection cross-agent.** Within one scan, a sub-agent that gets prompt-injected via attacker-controlled content can drive its tools to read another agent's transcripts (on host) or trample another agent's `/workspace` files. There is no in-container enforcement preventing this. Tracked in [roadmap.md §26](roadmap.md).

3. **Unrestricted egress.** Once the agent's tools execute, network calls are not constrained to the authorized targets. A jailbroken agent could SSRF arbitrary endpoints, exfiltrate to webhooks, etc. Tracked in [roadmap.md §26](roadmap.md).

4. **Caido CA private key in the public image.** `/app/certs/ca.key` is generated at image build time. Anyone who pulls `ghcr.io/usestrix/strix-sandbox` has the same CA private key. Inside one container this is fine — interception happens within the sandbox boundary. **It becomes a problem if a user copies the CA cert out of the container and trusts it system-wide on a host**: anyone with the public image can then decrypt that host's Caido-intercepted HTTPS traffic.

5. **Plain `!=` token comparison.** `verify_token` does `credentials.credentials != EXPECTED_TOKEN`. Constant-time comparison would be a one-line fix using `secrets.compare_digest`. Risk in practice is negligible given 256-bit entropy.

6. **Plaintext HTTP transport.** Host ↔ sandbox is plain HTTP. Fine on loopback. Not fine over a remote `DOCKER_HOST` — users have to provide their own TLS/SSH tunnel.

7. **No `--security-opt no-new-privileges`.** Combined with `cap_add NET_ADMIN/NET_RAW`, a sandbox-internal RCE has more network primitives than a default container. No custom seccomp/apparmor profile is shipped.

8. **No per-agent egress / FS policy.** Agents are isolated by ContextVar, not by namespace. There is no equivalent of `unshare`, no per-agent network namespace, no per-agent filesystem mount.

9. **No multi-tenant model.** OS users sharing a host share the Docker daemon; scan ownership and audit don't exist.

10. **Workspace edits don't sync back to host.** Source is copied into the container, not bind-mounted. Agent-applied fixes live in the container only and are lost on teardown unless explicitly extracted. Worth knowing — it's also intentional, since it prevents an agent from corrupting your working tree.

---

## 11. Hardening Recommendations

Quick wins (small code changes, real defense-in-depth):

- Use `secrets.compare_digest` in `verify_token`.
- Add `security_opt=["no-new-privileges:true"]` to `containers.run`.
- Ship a custom seccomp profile that drops obviously unneeded syscalls.
- Generate the Caido CA at first **container start** (in `docker-entrypoint.sh`) instead of at image build, so each container has a unique CA.
- Add an explicit egress allowlist via `iptables`/`nftables` inside the entrypoint, derived from the authorized target list.
- Switch scan_id collision behavior from "force-remove" to "abort with clear error" unless an explicit `--resume` flag is set.

Larger items already in [roadmap.md](roadmap.md):

- §9 — alternate runtimes (Kubernetes Job, Fargate, BYO remote sandbox) for stronger blast-radius control.
- §25 — RBAC + SSO + audit log for self-hosted multi-tenant deployments.
- §26 — prompt-injection & scope-escape defense at the runtime layer (egress firewall, untrusted-content tagging).
- §30 — alternative container runtimes (Podman rootless, containerd) which give different default-deny behaviors.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — project overview, architecture.
- [feature.md](feature.md) — every shipped feature in detail.
- [ToolCall.md](ToolCall.md) — how tool calls flow end-to-end (the transport this document constrains).
- [roadmap.md](roadmap.md) — gaps and priorities, including the items called out in §10–§11 above.
