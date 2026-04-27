# Strix Blog Pipeline

A curated list of blog post ideas to promote Strix, grouped by audience and intent. Each entry lists the **title**, the **target reader**, and a **brief** with the angle and what it should accomplish.

> **TL;DR.** 27 post ideas across 6 tiers — from top-of-funnel category-defining narratives, to engineering deep dives that earn credibility, to bottom-funnel comparison and pricing posts that close. A recommended 12-month publishing sequence is at the end.

---

## Table of Contents

1. [Tier 1 — Launch & Awareness (top-of-funnel)](#tier-1--launch--awareness-top-of-funnel)
2. [Tier 2 — Technical Deep Dives (engineer love)](#tier-2--technical-deep-dives-engineer-love)
3. [Tier 3 — Use Case Showcases (mid-funnel)](#tier-3--use-case-showcases-mid-funnel-conversion-driving)
4. [Tier 4 — Domain Authority Posts (SEO + thought leadership)](#tier-4--domain-authority-posts-seo--thought-leadership)
5. [Tier 5 — Community & Contributor Building](#tier-5--community--contributor-building)
6. [Tier 6 — Ops & Pricing Stories (bottom-funnel)](#tier-6--ops--pricing-stories-bottom-funnel-sales-supporting)
7. [Recommended Publishing Cadence](#recommended-publishing-cadence)
8. [Prioritization Logic](#prioritization-logic)
9. [Distribution Channels](#distribution-channels)

---

## Tier 1 — Launch & Awareness (top-of-funnel)

These build category awareness for "AI-powered offensive security" and put Strix on the map. The most important tier — these define the audience that everything else converts.

### 1. "We Built AI Hackers That Find Real Bugs — Here's How"

**Audience.** Security Twitter, Hacker News, security podcast listeners.

**Brief.** The flagship origin story. Why static analysis tools generate too many false positives, why human pentests are too slow, and why an autonomous agent that runs your code dynamically is the missing third option. Include 2–3 real bugs Strix found that other tools missed, with sanitized PoCs. End with the CLI quickstart. The single most shareable post — pin it to the front page.

### 2. "False Positives Are a Tax — How Validated Findings Change AppSec Economics"

**Audience.** AppSec engineers, CISOs evaluating their SAST/DAST stack.

**Brief.** Frame the cost of triaging false positives — engineering hours per finding, alert fatigue, security-team trust erosion. Show data: what % of typical SAST findings are real, how Strix's validation step (Discovery → Validation → Reporting pipeline) gates findings on a working PoC. Include a comparison table vs Snyk / Checkmarx / Veracode on a benchmark app.

### 3. "Stop Reading Reports. Read PoCs."

**Audience.** Skeptical engineers who've been burned by "AI-generated" security findings.

**Brief.** Short, opinionated. Every Strix finding ships with a reproducible PoC. Show three: a JWT secret brute-force, an IDOR via parameter tampering, a prototype pollution chain. Each with the actual command sequence the agent ran. Position Strix as the antidote to "AI tools that make stuff up."

### 4. "Why We Open-Sourced Our AI Pentester (And Why You Should Run It Locally)"

**Audience.** OSS-curious developers, privacy-conscious enterprises, indie hackers.

**Brief.** The strategic case for OSS in security tooling: trust-by-inspection, fork-friendly, no data leaving your perimeter when paired with local LLMs. Tie to Apache 2.0 license, point at the Ollama integration. Recruits contributors and signals to enterprises that adoption isn't lock-in.

---

## Tier 2 — Technical Deep Dives (engineer love)

These build credibility and rank for technical search queries. The currency of HN front-page placement.

### 5. "Building a Multi-Agent Security Swarm: Lessons From Strix's Graph-of-Agents"

**Audience.** AI engineers, agent-framework builders, the LangGraph / AutoGen crowd.

**Brief.** The orchestration story: why a Root Agent shouldn't do hands-on work, how the Discovery → Validation → Reporting → Fixing pipeline maps to nested sub-agents, why threads-with-event-loops beat asyncio tasks for sub-agents. Show the actual `_run_agent_in_thread` code. Strong technical post that earns AI-engineering audience respect. Cross-link to [multiagent.md](multiagent.md).

### 6. "Why Strix Doesn't Use MCP — A Defense of XML-in-Text Tool Calls"

**Audience.** People debating MCP vs native JSON vs custom protocols, Anthropic ecosystem watchers.

**Brief.** Take a real position. Provider portability across LiteLLM, forgiving regex parsing for local models, streamable tool intent, prompt-cacheable schemas. Concede where MCP wins (third-party plugins, resources). End with a hybrid model the team would consider. Generates discussion on HN and Twitter precisely *because* it's contrarian. The expanded form of [ToolCall.md](ToolCall.md) §1.

### 7. "The 100k-Token Conversation Problem: Memory Compression in Long-Running Agents"

**Audience.** Agent-framework engineers, LLM-app builders.

**Brief.** Walk through Strix's `MemoryCompressor`: token budget, image-budget pruning, last-15-messages-untouched rule, security-aware summarization prompt. Show side-by-side: a 200k-token conversation before and after. Pitch the principle that memory in offensive agents must preserve credentials, version numbers, and exact error strings — not generic chat semantics.

### 8. "How We Run a 50-Agent Pentest in One Docker Container Without Race Conditions"

**Audience.** Backend engineers, devtools authors.

**Brief.** The `agent_id` ContextVar pattern — how a single FastAPI tool server inside the sandbox routes terminal panes, IPython kernels, and Playwright tabs to the right agent without explicit session management on the call site. Includes the per-agent task slot and cancel-newer-overwrites-older semantics. Illustrated with code from [strix/tools/context.py](https://github.com/usestrix/strix/blob/main/strix/tools/context.py) and the per-tool managers.

### 9. "Inside the Strix Sandbox: A Kali Box on Demand for AI Agents"

**Audience.** DevOps, container nerds, security researchers.

**Brief.** Tour of the Dockerfile — Caido proxy with custom CA, Playwright, Trivy, every ProjectDiscovery tool, tree-sitter parsers for 8 languages. Why we copy source instead of bind-mounting. The 256-bit Bearer token boundary. End with how to swap `STRIX_IMAGE` for your own.

### 10. "Tool-Call Validation Without a Spec: Lessons From XML Schema In Strix"

**Audience.** AI engineers building tool-using agents.

**Brief.** How a self-correcting validation loop works: bad arg → string error to model → model fixes itself next turn. Why this is more pragmatic than rejecting at the schema level for LLM-generated calls. Show the actual `_validate_tool_arguments` code path.

---

## Tier 3 — Use Case Showcases (mid-funnel, conversion-driving)

These speak to specific buyer personas with their exact problem. The conversion tier.

### 11. "From PR to Pentest in 90 Seconds: Strix in GitHub Actions"

**Audience.** Platform engineers, AppSec leads choosing CI tools.

**Brief.** Step-by-step setup. The `--scope-mode auto` diff-scoping. How the exit code 2 gating works. Show a live PR with a Strix finding caught and fixed before merge. Embed a 90-second screen recording. The conversion piece — most readers will walk away with Strix in their pipeline.

### 12. "We Found 14 Vulns in [Open-Source Project] in Under an Hour. Here's the Run."

**Audience.** Bug-bounty hunters, OSS maintainers.

**Brief.** Pick a deliberately vulnerable target (Juice Shop, DVWA, an old WordPress) — a real one with permission. Run a deep scan, capture the actual `events.jsonl`, walk through what the agent did at each phase. End with the run name + run dir contents. Reproducibility is the point. Excellent SEO for "ai pentest [tool name]".

### 13. "Bug Bounty With AI: Strix as Your Recon + Triage Sidekick"

**Audience.** Bug-bounty hunters specifically.

**Brief.** Position Strix as a force multiplier, not a replacement. Show how `quick` mode + a tight `--instruction` produces a rapid attack-surface map and a short list of high-confidence pivots. Bug-bounty hunters are fast technical evaluators and high-affinity early adopters; this audience drives word-of-mouth.

### 14. "White-Box Pentests at the Speed of CI"

**Audience.** AppSec leads, Director-level buyers.

**Brief.** The white-box workflow — repo + deployed app combined, source-aware triage with semgrep + AST + secrets + Trivy, dynamic validation against the running app, fix-it-and-prove-it agent that re-runs the PoC against the patched build. Show the wiki-note shared-memory protocol. The "DAST + SAST in one tool" pitch.

### 15. "Pentest Reports That Auditors Accept (And Engineers Actually Read)"

**Audience.** SOC 2 / ISO 27001 / PCI-affected companies.

**Brief.** The Markdown vulnerability reports written to `strix_runs/<run>/vulnerabilities/`. Show CVSS, reproduction steps, code locations, remediation. Acknowledge what's missing today (compliance mapping is on the roadmap) and tease the SaaS platform's compliance reports.

---

## Tier 4 — Domain Authority Posts (SEO + thought leadership)

Each ranks for a meaningful keyword and demonstrates technical authority. Long-tail SEO compounding.

### 16. "Prompt Injection Inside Your Pentester: A Threat Model for Autonomous Security Agents"

**Audience.** Security researchers, AI safety folks, security buyers due-diligencing AI tools.

**Brief.** Honest threat-modeling. What happens when an attacker injects instructions into a page Strix scrapes? Walk through Strix's current isolation guarantees (per-agent ContextVar routing, fresh container per scan), what's *not* enforced (egress firewall, cross-agent FS), and what the roadmap plans. Cross-link to [Isolation.md](Isolation.md) and [roadmap.md](roadmap.md) §26. Honesty buys credibility — security buyers respect tools that publish their threat model.

### 17. "Comparing AI-Driven Pentest Tools in 2026: Strix vs PentestGPT vs Burp AI vs Pynt"

**Audience.** Buyers actively evaluating.

**Brief.** Genuine head-to-head on the same target. Methodology, findings count, false-positive rate, integration breadth, OSS vs SaaS, model neutrality. Even-handed enough that competitors will share it. Comparison posts dominate search rankings for "AI pentest comparison".

### 18. "Why Reasoning Effort Matters More Than Model Size for Offensive Security"

**Audience.** AI-curious technical buyers.

**Brief.** Compare the same scan run on `STRIX_REASONING_EFFORT=low` vs `high` against the same target. Show the cost / coverage / depth tradeoff. Position deep reasoning as the unlock for chained vulnerabilities specifically.

### 19. "The CWE Coverage Map: 17 Vulnerability Classes Strix Tests By Default"

**Audience.** Security buyers checking the box on coverage.

**Brief.** One vulnerability class per section: SQLi, XSS, IDOR, RCE, SSRF, XXE, CSRF, JWT, race conditions, business logic, mass assignment, open redirect, subdomain takeover, info disclosure, file upload, BFLA, path traversal. For each: what we look for, the skill that drives it, a sample finding. Excellent SEO for individual CWE searches.

### 20. "What Local LLMs Can (And Can't) Do for Security Testing"

**Audience.** Privacy-driven enterprises, regulated industries.

**Brief.** Hands-on benchmark of `ollama/llama3.1:70b`, `qwen2.5:72b`, `deepseek-r1` running Strix scans, vs Claude / GPT-5. Where local models match, where they fall behind. Shows the air-gap story is real and quantifies the cost.

---

## Tier 5 — Community & Contributor Building

These bring developers into the ecosystem. High leverage — every skill / tool a contributor adds expands product surface.

### 21. "Write a Strix Skill in 20 Minutes"

**Audience.** Security researchers, would-be contributors.

**Brief.** Tutorial on adding a Markdown skill in `strix/skills/`. Pick something concrete — say, a `template_injection.md` skill. Walk through frontmatter, payload examples, validation guidance. Zero Python required. The highest-leverage contributor onramp.

### 22. "Adding Your First Tool to Strix"

**Audience.** Python-comfortable developers who want to extend the agent.

**Brief.** Code-walkthrough: write a tool function, decorate with `@register_tool`, write the XML schema, add the import. Include the dispatch flow so contributors understand what's happening under the hood. Maybe pair with a real PR contribution. Cross-link to [ToolCall.md](ToolCall.md) §11.

### 23. "Lessons From the Strix Skill Library: How We Document a Century of Hacker Knowledge"

**Audience.** Security practitioners who want to share their playbooks.

**Brief.** Editorial post about how the team distilled vulnerability classes into agent-readable Markdown — what makes a good skill (advanced techniques, working payloads, validation methods, false-positive filters), what makes a bad one. Recruits skill PRs.

### 24. "First-Time Contributors: Here's a List of Skills the Community Wants"

**Audience.** OSS contributors looking for starter issues.

**Brief.** A live list — server-side template injection, NoSQL injection, HTTP request smuggling, OAuth flaws, prototype pollution, etc. (sourced from [roadmap.md](roadmap.md) §7). Make the post evergreen by linking to a tracking GitHub issue.

---

## Tier 6 — Ops & Pricing Stories (bottom-funnel, sales-supporting)

### 25. "How Much Does It Cost to Run Strix on Your Codebase?"

**Audience.** Procurement-aware buyers, finance-conscious technical leaders.

**Brief.** Concrete cost breakdown for `quick`, `standard`, `deep` modes on small / medium / large repos with each major model. Show the LLM-stats panel from real runs. Talks honestly about $X per scan and how prompt caching cuts repeated scans dramatically.

### 26. "Self-Hosting Strix in an Air-Gapped Network"

**Audience.** Defense, healthcare, finance — air-gap-required customers.

**Brief.** End-to-end guide: pulling the Docker image to an internal registry, running Strix against a local Llama 3.1 70B with vLLM, what's lost vs cloud models. Clears the path for the highest-value enterprise segment.

### 27. "Self-Hosted vs SaaS Strix: Which to Pick"

**Audience.** Buyers comparing offerings.

**Brief.** Honest decision guide. Self-host wins on data residency and control. SaaS wins on autofix PRs, continuous monitoring, integrations, compliance reports. Doesn't oversell — doing this honestly creates inbound trust.

---

## Recommended Publishing Cadence

If you ship two posts a month, here's a 12-month sequence that builds momentum.

| Month | Posts | Theme |
|---|---|---|
| 1 | #1 (origin story) + #11 (CI quickstart) | **Launch.** Define the category, give buyers a 90-second path to integration. |
| 2 | #5 (multi-agent deep dive) + #12 (real findings) | **Earn engineers.** Technical credibility + reproducible proof. |
| 3 | #2 (false positives economics) + #21 (write a skill) | **AppSec leads + community.** Cost framing + contributor onramp. |
| 4 | #6 (XML vs MCP) + #14 (white-box CI) | **Fuel debate + convert.** A contrarian engineering post and a clear buyer pitch. |
| 5 | #16 (threat model) + #25 (pricing) | **Earn enterprise trust.** Honest threat model + transparent costs. |
| 6 | #17 (comparison) + #13 (bug bounty) | **Active evaluation.** Competitive comparison + viral bug-bounty pitch. |
| 7 | #7 (memory compression) + #15 (audit reports) | **Expand engineer base + serve compliance buyers.** |
| 8 | #20 (local LLMs) + #22 (add a tool) | **Privacy story + deeper contributor pitch.** |
| 9 | #3 (read PoCs) + #19 (CWE map) | **Reset positioning + huge SEO surface.** |
| 10 | #9 (sandbox tour) + #26 (air-gapped) | **Engineer trust + enterprise segment.** |
| 11 | #4 (open source case) + #27 (self-host vs SaaS) | **Reinforce OSS + sales-cycle support.** |
| 12 | #8 (50-agent container) + #18 (reasoning effort) | **Year-end engineering showcase + technical sophistication.** |

Posts not slotted in the 12-month plan (#10, #23, #24) are evergreen pieces to slot in as gaps appear, news pegs arise, or contributor pushes need fuel.

---

## Prioritization Logic

The order isn't arbitrary. Three forces shape it:

1. **Tier 1 first.** You cannot convert an audience that doesn't exist. Posts #1–#4 define the category and the audience that #11–#15 then convert.
2. **Engineer love before enterprise sales.** A post that earns 200 upvotes on HN moves more enterprise pipeline than a post written *for* enterprise. So Tier 2 deep dives go before Tier 6 pricing posts.
3. **Honest threat-modeling early.** #16 is an unconventional placement — most tools hide their threat model. Publishing it early signals confidence and pre-empts the inevitable security researcher who would otherwise write the same post critically.

What's deliberately *not* on this list:

- **"How AI is changing security"** — too generic, too late, search-dominated by McKinsey.
- **"5 ways AI helps developers"** — listicle slop, no positioning.
- **Vendor case studies without permission** — risk vs benefit is wrong; do them only when a customer offers.

---

## Distribution Channels

Per-post channel match:

| Tier | Primary | Secondary |
|---|---|---|
| 1 (Awareness) | Twitter/X, Hacker News, LinkedIn | Reddit r/netsec, r/cybersecurity, security newsletters |
| 2 (Deep dives) | Hacker News, Twitter/X | dev.to, Lobsters, AI engineering newsletters (Latent Space, etc.) |
| 3 (Use cases) | Twitter/X, LinkedIn | DevSecOps Slack/Discord, GitHub README badge |
| 4 (Authority) | Search (SEO-led) | Comparison sites (G2, Slashdot), security buyer LinkedIn |
| 5 (Community) | GitHub Discussions, Discord, Twitter/X | Reddit r/programming, contributor newsletters |
| 6 (Ops/pricing) | Direct sales follow-up, gated download | LinkedIn, customer email |

Cross-cutting moves:

- **Pin #1 to the GitHub README** as the front door.
- **Embed every post in a `docs.strix.ai/blog/<slug>` route** so docs SEO compounds with blog SEO.
- **Convert the top 3 deep dives into 5-min YouTube walkthroughs** — security YouTube is underserved.
- **Repackage #19 (CWE map) as 17 individual landing pages** — one per CWE — for long-tail SEO.

---

## See Also

- [Strix README](https://github.com/usestrix/strix#readme) — the audience-facing front door blog content links back to.
- [feature.md](feature.md) — source for "what does it actually do" framing.
- [orchestration-logic.md](orchestration-logic.md), [multiagent.md](multiagent.md), [ToolCall.md](ToolCall.md), [Isolation.md](Isolation.md), [data-flow.md](data-flow.md) — sources for technical deep-dive posts.
- [roadmap.md](roadmap.md) — what's coming, useful for "what we're building next" posts (#24).
- [user-inputs.md](user-inputs.md) — buyer-facing reference; pull from this for use-case posts (#11–#15).
