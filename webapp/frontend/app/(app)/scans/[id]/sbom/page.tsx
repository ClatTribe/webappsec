import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import SbomClient from './sbom-client';

// /scans/[id]/sbom — dedicated SBOM viewer.
//
// Server-side, this page only confirms visibility + that the SBOM
// flag is set; the actual CycloneDX file is fetched client-side via
// `/api/scans/[id]/sbom` so the operator's filter / sort / search
// state lives entirely in the browser without bouncing through the
// server on every interaction.
//
// Wishlist §14.6 row 1 (sortable / filterable table) + row 3
// (CycloneDX export download button — links to the same route with
// `?format=cyclonedx`).

export default async function SbomPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: scan } = await supabase
    .from('scans')
    .select('id, run_name, sbom_uploaded')
    .eq('id', params.id)
    .single();
  if (!scan) {
    notFound();
  }
  if (!scan.sbom_uploaded) {
    return (
      <div className="space-y-4">
        <Breadcrumb scanId={scan.id} runName={scan.run_name} />
        <section className="rounded-2xl border border-neutral-800/80 bg-neutral-900/30 p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-100">Component list not available yet</h1>
          <p className="mt-2 text-sm text-neutral-400">
            We didn&apos;t generate a software component list for this scan, or the
            upload is still in flight. Scans against very simple targets (no
            detectable dependencies) won&apos;t produce one.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Breadcrumb scanId={scan.id} runName={scan.run_name} />
      <SbomClient scanId={scan.id} runName={scan.run_name} />
    </div>
  );
}

function Breadcrumb({ scanId, runName }: { scanId: string; runName: string }) {
  return (
    <nav className="flex items-center gap-1.5 text-xs text-neutral-500">
      <Link href="/scans" className="transition-colors hover:text-neutral-300">
        Scans
      </Link>
      <ChevronRight className="h-3 w-3" />
      <Link
        href={`/scans/${scanId}`}
        className="transition-colors hover:text-neutral-300"
      >
        {runName}
      </Link>
      <ChevronRight className="h-3 w-3" />
      <span className="text-neutral-300">Component list</span>
    </nav>
  );
}
