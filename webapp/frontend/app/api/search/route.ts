import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// GET /api/search?q=<query>
//
// Powers the ⌘K command palette. Searches across the four primary
// entities (assets / findings / scans / projects) with a single
// short query. RLS gates every read; we don't have to filter by
// org_id manually here.
//
// Performance: each branch is `ilike '%q%' limit 5`. Postgres uses
// a sequential scan for `ilike` on small tables, which is fine at
// our row counts. If a future tenant grows past ~50k rows in any
// of these tables we'll add a trigram index — defer until needed.

export const dynamic = 'force-dynamic';

const MIN_Q_LEN = 2;
const PER_TYPE_LIMIT = 5;

interface PaletteResult {
  group: 'assets' | 'findings' | 'scans' | 'projects';
  id: string;
  label: string;
  sublabel?: string | null;
  href: string;
}

export async function GET(req: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < MIN_Q_LEN) {
    return NextResponse.json({ q, results: [] });
  }
  // Escape Postgres ilike wildcards in user input so a query of "%"
  // doesn't match everything. We're using template literals to
  // interpolate, so a poisoned q could otherwise leak rows.
  const safeQ = q.replace(/[%_\\]/g, (c) => `\\${c}`);
  const pattern = `%${safeQ}%`;

  const [assetsRes, findingsRes, scansRes, projectsRes] = await Promise.all([
    supabase
      .from('targets')
      .select('id, name, type, value, status')
      .eq('status', 'active')
      .or(`name.ilike.${pattern},value.ilike.${pattern}`)
      .limit(PER_TYPE_LIMIT),
    supabase
      .from('findings')
      .select('id, title, severity, status')
      .ilike('title', pattern)
      .limit(PER_TYPE_LIMIT),
    supabase
      .from('scans')
      .select('id, run_name, status, created_at')
      .ilike('run_name', pattern)
      .order('created_at', { ascending: false })
      .limit(PER_TYPE_LIMIT),
    supabase
      .from('projects')
      .select('id, slug, name, criticality')
      .is('archived_at', null)
      .ilike('name', pattern)
      .limit(PER_TYPE_LIMIT),
  ]);

  const results: PaletteResult[] = [];

  for (const a of (assetsRes.data ?? []) as Array<{
    id: string;
    name: string;
    type: string;
    value: string;
  }>) {
    results.push({
      group: 'assets',
      id: a.id,
      label: a.name,
      sublabel: `${a.type} · ${a.value.slice(0, 60)}`,
      href: `/assets/${a.id}`,
    });
  }
  for (const f of (findingsRes.data ?? []) as Array<{
    id: string;
    title: string | null;
    severity: string | null;
    status: string;
  }>) {
    results.push({
      group: 'findings',
      id: f.id,
      label: f.title ?? '(untitled finding)',
      sublabel: `${f.severity ?? 'info'} · ${f.status}`,
      href: `/findings/${f.id}`,
    });
  }
  for (const s of (scansRes.data ?? []) as Array<{
    id: string;
    run_name: string | null;
    status: string;
    created_at: string;
  }>) {
    results.push({
      group: 'scans',
      id: s.id,
      label: s.run_name ?? '(unnamed scan)',
      sublabel: `${s.status} · ${new Date(s.created_at).toLocaleDateString()}`,
      href: `/scans/${s.id}`,
    });
  }
  for (const p of (projectsRes.data ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    criticality: string;
  }>) {
    results.push({
      group: 'projects',
      id: p.id,
      label: p.name,
      sublabel: `${p.criticality.replace('_', ' ')} · /projects/${p.slug}`,
      href: `/projects/${p.slug}`,
    });
  }

  return NextResponse.json({ q, results });
}
