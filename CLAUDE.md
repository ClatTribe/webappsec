# Agent guide for `webappsec`

If you're a Claude Code session picking up work in this repo, read this once before designing anything.

---

## The non-negotiable: Strix is the source of truth, `webappsec` is a wrapper

Strix (https://github.com/usestrix/strix) is the AI security agent that has first-hand view of the codebase, the running app, network behaviour, and the actual exploit attempt. **Anything related to detection or triage data — file paths, line numbers, code snippets, fix proposals, vulnerability metadata, event timelines — must come from Strix as structured data and be consumed as-is.** The wrapper does not re-derive what Strix already produces.

Concrete rules:

1. **Before writing any parser, extractor, or regex against Strix's output**, read [`strix/telemetry/tracer.py`](https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py) and surrounding files. If Strix already emits the data structurally (in events.jsonl, in a JSON sidecar, as a CSV column), consume that — don't re-derive from prose. We learned this the hard way in PR #31 → PR #32: shipped a regex-over-markdown extractor for `affected_files`, then deleted most of it once we noticed Strix had been emitting `code_locations` all along.

2. **Mirror Strix's data model where you can.** Our `findings.affected_files` carries the same shape as Strix's `code_locations`. Our `scan_events.event_type` mirrors Strix's event names (`finding.created`, `agent.created`, `tool.execution_started`). Schema fidelity makes the wrapper thin and drift catchable.

3. **Layer, never replace.** When the wrapper adds analysis (AI urgency triage, cross-scan dedup, RAG context, the UI), it takes Strix's output as input and enriches it. Strix's own `severity` is preserved verbatim even when downstream AI triage says `dismiss`. The two signals coexist; the user sees both.

4. **When Strix is missing something we need, prefer an upstream contribution over a wrapper-side workaround.** Wrapper-side parsing is a maintenance treadmill — Strix changes its format → our parser breaks. Upstream the fix; keep wrapper-side regex as a fallback for older Strix versions only.

5. **One exception: tenant boundaries.** Multi-tenant isolation (RLS, org_id keying, vault encryption, credential materialisation, real-time subscriptions filtered by org) is the wrapper's exclusive responsibility. Strix is single-tenant by design. The wrapper is what makes it safe to run thousands of scans across hundreds of orgs.

The full reasoning is in [`Architecture.md` §1.1](Architecture.md#11-design-principles).

---

## Operational habits that have already saved time

- **Don't run `npx next build` against a directory with a live `next dev` server.** They share `.next/`; the build will stomp the dev cache and the dev server will start serving 404s for its own CSS bundle until you wipe `.next/` and restart. For typecheck-only verification, use `npx tsc --noEmit` (changes nothing on disk).
- **Worker tests:** `pip install -e .` + `pip install pytest pytest-asyncio` in a venv, then `python -m pytest tests/`. The worker uses `uv` in production but pytest works fine without it for local TDD.
- **Local Supabase migrations:** `supabase db push` from `webapp/`. Then verify with `docker exec supabase_db_strix-webapp psql -U postgres -d postgres -c "..."`. Don't reach for `psql` directly — it's not installed on the host.
- **Roadmap-as-spec.** [`roadmap.md`](roadmap.md) §10 is the active doctrine. Each row has a status emoji (✅ done, 🚧 partial, ⬜ not started) and an effort sizing. Update the row in the same PR that closes/advances the work.

---

## How to size a PR in this repo

The recent cadence has been:

- **S** — single-file or single-concept change. Ship in one PR. Examples: PR #28 (finding card design refresh), PR #29 (cross-scan dedup ledger).
- **M** — touches schema + worker + frontend together. Still one PR if the slice is coherent. Example: PR #30 (inline triage at scan finalize).
- **L** — when a roadmap row is L, look for a stage cut. PR #31 + #32 split the "RAG with codebase context" L-row into Stage A.0 (consume Strix's structured data) and an optional Stage B (pgvector for related code). Don't ship a 600-line bolt-on that turns out to be re-deriving what Strix already emits — investigate the upstream first.

When in doubt: smaller is better. Ship the foundation, then a follow-up.
