// Continuous evidence collector registry.
//
// Single source of truth for which collectors exist + their static
// metadata. The UI lists from here, the cron route resolves a
// `collector_id` to its implementation via this map, and unit tests
// import individual collectors directly without going through the
// registry.

import { awsIamCollector } from './aws-iam';
import { githubAdminCollector } from './github';
import type { CollectorDefinition } from './types';

export const COLLECTORS: CollectorDefinition[] = [
  githubAdminCollector,
  awsIamCollector,
];

/** Map lookup by collector id. Returns null if the id isn't known —
 *  the runner treats that as a non-fatal `status='skipped'` so a
 *  stale row in evidence_collectors for a since-removed collector
 *  doesn't block the cron. */
export function findCollector(id: string): CollectorDefinition | null {
  return COLLECTORS.find((c) => c.id === id) ?? null;
}

/** What the UI surfaces on /compliance/collectors — a static catalog
 *  card per collector with description + scopes + control count. */
export interface CollectorCatalogEntry {
  id: string;
  provider: string;
  display_name: string;
  description: string;
  integration_type: string;
  controls_emitted: number;
  default_frequency_minutes: number;
}

export function listCatalog(): CollectorCatalogEntry[] {
  return COLLECTORS.map((c) => ({
    id: c.id,
    provider: c.provider,
    display_name: c.display_name,
    description: c.description,
    integration_type: c.integration_type,
    controls_emitted: c.controls_emitted,
    default_frequency_minutes: c.default_frequency_minutes,
  }));
}
