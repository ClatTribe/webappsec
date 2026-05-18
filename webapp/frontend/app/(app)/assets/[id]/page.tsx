import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import TargetView from './target-view';
import type { Finding, Scan, Target } from '@/lib/supabase/types';

interface Props {
  params: { id: string };
  searchParams: { tab?: string };
}

export default async function TargetDetailPage({ params, searchParams }: Props) {
  const supabase = createClient();
  const { data: target } = await supabase
    .from('targets')
    .select('*')
    .eq('id', params.id)
    .single();
  if (!target) notFound();

  const [{ data: scans }, { data: findings }] = await Promise.all([
    supabase
      .from('scans')
      .select('*')
      .eq('target_id', params.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('findings')
      .select('*')
      .eq('target_id', params.id)
      .order('created_at', { ascending: false }),
  ]);

  return (
    <TargetView
      target={target as Target}
      scans={(scans as Scan[]) ?? []}
      findings={(findings as Finding[]) ?? []}
      initialTab={searchParams.tab}
    />
  );
}
