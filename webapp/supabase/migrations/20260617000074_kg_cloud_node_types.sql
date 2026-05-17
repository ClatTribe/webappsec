-- Cloud asset inventory — widen the knowledge-graph CHECKs to accept
-- the typed cloud nodes the engine emits from PRs #240/#265/#266 and
-- the cloud-attack-path graph (#293/#294).
--
-- Before this migration, `kg_nodes.node_type` was restricted to the 9
-- legacy types (Surface / Asset / Vuln / Credential / Secret /
-- Dependency / Role / ThreatIntel / Exploit). The engine's CloudGraph
-- in `strix/cloud_attack_paths/graph.py` writes CloudResource /
-- CloudIdentity / CloudPolicy — those rows fail their INSERT today
-- because the CHECK rejects them. This migration opens the door so
-- the next CSPM scan with cloud_account target persists its asset
-- graph instead of silently dropping rows.
--
-- Same story on `kg_edges.edge_type` — engine PR #293's edges
-- (exposed_to_internet / attached_to / can_assume / has_policy) need
-- to be acceptable for the inventory page to render cloud relationships.

-- ============================================================================
-- 1. kg_nodes — widen the node-type taxonomy
-- ============================================================================

alter table public.kg_nodes
  drop constraint kg_nodes_node_type_check;

alter table public.kg_nodes
  add constraint kg_nodes_node_type_check
  check (node_type = any (array[
    -- Legacy application-security types (engine PRs #240/#265/#266)
    'Surface',
    'Asset',
    'Vuln',
    'Credential',
    'Secret',
    'Dependency',
    'Role',
    'ThreatIntel',
    'Exploit',
    -- Cloud-graph types (engine PRs #290/#291/#293)
    --
    --   CloudResource     — S3 bucket, EC2 instance, RDS DB, etc.
    --   CloudIdentity     — IAM user, role, service account
    --   CloudPolicy       — IAM policy, security-group rule, KMS key policy
    --   CloudFlow         — VPC flow log peer / cross-account trust
    --   ExternalPrincipal — '*' or arn:aws:iam::123:root in a trust policy
    'CloudResource',
    'CloudIdentity',
    'CloudPolicy',
    'CloudFlow',
    'ExternalPrincipal'
  ]));

comment on column public.kg_nodes.node_type is
  'KG node taxonomy. Application-security types (Surface / Asset / Vuln '
  '/ Credential / Secret / Dependency / Role / ThreatIntel / Exploit) '
  'from engine PRs #240/#265/#266. Cloud-graph types (CloudResource / '
  'CloudIdentity / CloudPolicy / CloudFlow / ExternalPrincipal) from '
  'engine PRs #290/#291/#293.';

-- ============================================================================
-- 2. kg_edges — widen the edge-type taxonomy
-- ============================================================================

alter table public.kg_edges
  drop constraint kg_edges_edge_type_check;

alter table public.kg_edges
  add constraint kg_edges_edge_type_check
  check (edge_type = any (array[
    -- Legacy application-security edges
    'AFFECTS',
    'REACHABLE_FROM',
    'LEAKS',
    'GRANTS_ACCESS_TO',
    'CHAINS_TO',
    'RUNS_ON',
    'USES',
    'OBSERVED',
    'PIVOTED_FROM',
    'EXPLOITS',
    -- Cloud-graph edges (engine PR #293)
    --
    --   exposed_to_internet  — resource has a public ingress path
    --   attached_to          — identity attached to resource / policy attached to identity
    --   can_assume           — IAM principal can assume role
    --   has_policy           — identity has policy attached
    --   trusts               — role trusts external principal
    'exposed_to_internet',
    'attached_to',
    'can_assume',
    'has_policy',
    'trusts'
  ]));

comment on column public.kg_edges.edge_type is
  'KG edge taxonomy. Application-security edges (PRs #240/#265/#266) '
  'plus cloud-graph edges (PR #293).';

-- ============================================================================
-- 3. RPC: kg_cloud_inventory(scan_id) — service-aware rollup
--
-- Cloud KG nodes carry the AWS / GCP / Azure service identifier in
-- props.service (e.g. "s3", "ec2", "iam", "rds"). The inventory page
-- groups by service for the at-a-glance "5 S3 buckets · 12 IAM roles
-- · 3 RDS instances" rollup. This RPC is the canonical fetch path so
-- the component doesn't re-derive it every render.
-- ============================================================================

drop function if exists public.kg_cloud_inventory(uuid);

create or replace function public.kg_cloud_inventory(p_scan_id uuid)
returns table (
  node_id          text,
  node_type        text,
  service          text,
  display_name     text,
  exposed_to_internet boolean,
  finding_count    int,
  attack_path_count int,
  props            jsonb,
  created_at       timestamptz
)
language sql
security invoker
set search_path = public
stable
as $$
  with nodes as (
    select
      n.node_id,
      n.node_type,
      coalesce(n.props->>'service', 'unknown') as service,
      coalesce(n.props->>'name', n.props->>'arn', n.node_id) as display_name,
      n.props,
      n.created_at
    from public.kg_nodes n
    where n.scan_id = p_scan_id
      and n.node_type in (
        'CloudResource', 'CloudIdentity', 'CloudPolicy',
        'CloudFlow', 'ExternalPrincipal'
      )
  ),
  exposure as (
    -- A node is "exposed to internet" if any outgoing edge is
    -- typed exposed_to_internet OR an incoming edge from an
    -- ExternalPrincipal lands on it.
    select source_node_id as node_id from public.kg_edges
     where scan_id = p_scan_id and edge_type = 'exposed_to_internet'
  ),
  finding_counts as (
    -- Count findings whose features.affected_node = this node_id.
    -- Engine PR #293's attack-path findings carry the constituent
    -- node IDs in features.hops; we just want any reference.
    select (f.features->>'affected_node') as node_id, count(*)::int as cnt
      from public.findings f
     where f.scan_id = p_scan_id
       and f.features ? 'affected_node'
     group by 1
  ),
  attack_path_counts as (
    -- Count cap_* findings that include this node in their hop chain.
    -- We expand features.hops jsonb-array elements and count per node.
    select hop_node as node_id, count(distinct f.id)::int as cnt
      from public.findings f
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(f.features->'hops') = 'array'
             then f.features->'hops'
             else '[]'::jsonb
        end
      ) as hop_node
     where f.scan_id = p_scan_id
       and f.category = 'cloud_attack_path'
     group by hop_node
  )
  select
    n.node_id,
    n.node_type,
    n.service,
    n.display_name,
    (n.node_id in (select node_id from exposure)) as exposed_to_internet,
    coalesce(fc.cnt, 0) as finding_count,
    coalesce(apc.cnt, 0) as attack_path_count,
    n.props,
    n.created_at
  from nodes n
  left join finding_counts fc on fc.node_id = n.node_id
  left join attack_path_counts apc on apc.node_id = n.node_id
  order by
    -- Most-exposed + most-pathfound first.
    (case when n.node_id in (select node_id from exposure) then 0 else 1 end),
    coalesce(apc.cnt, 0) desc,
    coalesce(fc.cnt, 0) desc,
    n.service,
    n.display_name;
$$;

grant execute on function public.kg_cloud_inventory(uuid) to authenticated;

comment on function public.kg_cloud_inventory(uuid) is
  'Cloud asset inventory RPC. Returns CloudResource / CloudIdentity / '
  'CloudPolicy nodes for a scan with derived exposure status + finding '
  'count + attack-path participation. Powers /scans/<id> cloud inventory '
  'panel. RLS via kg_nodes / kg_edges / findings row policies.';

-- ============================================================================
-- 4. RPC: kg_cloud_neighbours(scan_id, node_id) — drill-in edges
-- ============================================================================

drop function if exists public.kg_cloud_neighbours(uuid, text);

create or replace function public.kg_cloud_neighbours(
  p_scan_id uuid,
  p_node_id text
)
returns table (
  direction text,    -- 'out' or 'in'
  edge_type text,
  other_node_id text,
  other_node_type text,
  other_display_name text,
  edge_props jsonb
)
language sql
security invoker
set search_path = public
stable
as $$
  (
    select
      'out'::text as direction,
      e.edge_type,
      e.target_node_id as other_node_id,
      n.node_type as other_node_type,
      coalesce(n.props->>'name', n.props->>'arn', n.node_id) as other_display_name,
      e.props as edge_props
    from public.kg_edges e
    left join public.kg_nodes n
      on n.scan_id = e.scan_id and n.node_id = e.target_node_id
    where e.scan_id = p_scan_id
      and e.source_node_id = p_node_id
  )
  union all
  (
    select
      'in'::text as direction,
      e.edge_type,
      e.source_node_id as other_node_id,
      n.node_type as other_node_type,
      coalesce(n.props->>'name', n.props->>'arn', n.node_id) as other_display_name,
      e.props as edge_props
    from public.kg_edges e
    left join public.kg_nodes n
      on n.scan_id = e.scan_id and n.node_id = e.source_node_id
    where e.scan_id = p_scan_id
      and e.target_node_id = p_node_id
  )
  order by direction, edge_type;
$$;

grant execute on function public.kg_cloud_neighbours(uuid, text) to authenticated;

comment on function public.kg_cloud_neighbours(uuid, text) is
  'Drill-in for one cloud KG node. Returns incoming + outgoing edges '
  'with the neighbour node display name. Used by the inventory panel '
  'expand-row to show what this resource is connected to.';
