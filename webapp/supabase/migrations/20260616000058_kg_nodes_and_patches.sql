-- Strix PRs #240 + #265 + #266 (typed knowledge graph) + #243 + #250 (Patcher).
--
-- Two related additions:
--
--   1. `kg_nodes` + `kg_edges` — persist the per-scan knowledge graph the
--      engine writes to `<run_dir>/kg.json`. Lets us answer "what did
--      this scan learn about the target?" — discovered assets, surfaces,
--      secrets, credentials, dependencies, threat-intel observations,
--      synthesised exploits, plus the relationships between them.
--
--   2. `findings.patch_*` columns — capture the Patcher specialist's
--      proposed unified-diff fixes, one per finding. Engine writes
--      `<run_dir>/patches.jsonl`; we map each row by `finding_id` onto
--      the matching findings row.
--
-- Both are read-only ingest from engine artifacts (mirroring the
-- compliance_evidence pattern from migration 046) — the wrapper never
-- re-derives KG nodes or proposes its own patches.
--
-- RLS: org-scoped read; service-role-only insert (worker uses the
-- service-role client). Cascading on scan delete keeps the rows tied
-- to the scan lifecycle.

-- ---------------------------------------------------------------------------
-- 1. kg_nodes — one row per engine-emitted GraphNode
-- ---------------------------------------------------------------------------

create table if not exists public.kg_nodes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete cascade,
  scan_id      uuid not null references public.scans on delete cascade,
  -- Engine's stable per-graph identifier — N-001, N-002, …. Unique
  -- within a scan; used as the source/target of kg_edges.
  node_id      text not null,
  -- Mirrors strix/agents/knowledge_graph.py NodeType literal. Free-text
  -- + CHECK so a new engine version that adds a node type doesn't
  -- require a migration before the wrapper accepts the row — it'll
  -- fail the CHECK and the ingest path logs + skips.
  node_type    text not null check (node_type in (
    'Surface', 'Asset', 'Vuln', 'Credential', 'Secret',
    'Dependency', 'Role', 'ThreatIntel', 'Exploit'
  )),
  -- Open-schema bag the engine populates per node type. The frontend
  -- renders the well-known fields (target, host, secret_kind, …) by
  -- node_type-aware templates; unknown keys fall through to a generic
  -- key→value list. We never validate the bag's shape on insert —
  -- engine drift = display gap, not a 500.
  props        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (scan_id, node_id)
);

create index if not exists kg_nodes_scan_kind
  on public.kg_nodes (scan_id, node_type);
create index if not exists kg_nodes_org_kind
  on public.kg_nodes (org_id, node_type);

comment on table public.kg_nodes is
  'Engine-emitted KG node, one row per GraphNode in <run_dir>/kg.json '
  '(strix PRs #240/#265/#266). Source of truth for the scan-detail '
  '"Discovered" panel: assets, surfaces, secrets, credentials, '
  'dependencies, threat-intel, exploits. Engine writes; wrapper reads.';

alter table public.kg_nodes enable row level security;

drop policy if exists kg_nodes_org_read on public.kg_nodes;
create policy kg_nodes_org_read on public.kg_nodes
  for select using (org_id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- 2. kg_edges — one row per engine-emitted GraphEdge
-- ---------------------------------------------------------------------------

create table if not exists public.kg_edges (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations on delete cascade,
  scan_id         uuid not null references public.scans on delete cascade,
  edge_id         text not null,
  edge_type       text not null check (edge_type in (
    'AFFECTS', 'REACHABLE_FROM', 'LEAKS', 'GRANTS_ACCESS_TO',
    'CHAINS_TO', 'RUNS_ON', 'USES', 'OBSERVED',
    'PIVOTED_FROM', 'EXPLOITS'
  )),
  source_node_id  text not null,  -- references kg_nodes.node_id within same scan
  target_node_id  text not null,
  props           jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (scan_id, edge_id)
);

create index if not exists kg_edges_scan
  on public.kg_edges (scan_id);
create index if not exists kg_edges_scan_source
  on public.kg_edges (scan_id, source_node_id);
create index if not exists kg_edges_scan_target
  on public.kg_edges (scan_id, target_node_id);

comment on table public.kg_edges is
  'Engine-emitted KG edge, one row per GraphEdge in <run_dir>/kg.json. '
  'source_node_id / target_node_id reference kg_nodes.node_id within '
  'the same scan; cross-scan correlation is the wrapper''s job and '
  'not yet implemented.';

alter table public.kg_edges enable row level security;

drop policy if exists kg_edges_org_read on public.kg_edges;
create policy kg_edges_org_read on public.kg_edges
  for select using (org_id = public.current_org_id());

-- ---------------------------------------------------------------------------
-- 3. findings.patch_* — Patcher specialist output
-- ---------------------------------------------------------------------------

alter table public.findings
  -- PATCH-<sha1[:12]> from the engine. Unique within a finding's
  -- patch history; we keep only the most-recent proposal per finding
  -- (last write wins on re-scan).
  add column if not exists patch_id text,
  -- The unified-diff text the engine produced. Capped at 16KB by the
  -- engine itself (strix/agents/patcher.py) so we don't need a CHECK.
  -- Display-ready: feed straight into a diff renderer.
  add column if not exists patch_diff text,
  add column if not exists patch_commit_message text,
  -- proposed | applied | verified | failed. Reflects the engine's
  -- PatchStatus enum. Free-text so a future status doesn't block
  -- ingest.
  add column if not exists patch_status text,
  -- Set when the engine's auto_verify_patch confirmed the patch
  -- closed the finding (re-ran the original probe; probe failed
  -- to reproduce the exploit on the patched state).
  add column if not exists patch_verified_at timestamptz,
  -- When the engine wrote the patch into patches.jsonl. Distinct
  -- from findings.updated_at because the patch can arrive on a
  -- later scan than the original finding.
  add column if not exists patch_proposed_at timestamptz;

create index if not exists findings_patch_status
  on public.findings (org_id, patch_status)
  where patch_status is not null;

comment on column public.findings.patch_diff is
  'Unified-diff text proposed by the engine''s Patcher specialist '
  '(strix PRs #243/#250). Capped at 16KB upstream. Renders in the '
  'finding card''s "Suggested fix" tab. The wrapper does not derive '
  'or modify the diff — it''s engine-authored on every read.';
