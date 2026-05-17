// Asset-discoverer registry.
//
// Single source of truth for which discoverers exist + their static
// metadata. Mirrors the evidence-collector registry's shape so the
// patterns are interchangeable from a maintenance standpoint.

import { githubReposDiscoverer } from './github';
import type { DiscovererDefinition } from './types';

export const DISCOVERERS: DiscovererDefinition[] = [
  githubReposDiscoverer,
  // Future: awsResourcesDiscoverer, gcpResourcesDiscoverer,
  // domainSubdomainDiscoverer.
];

/** Lookup by id. Returns null for unknown ids (the cron treats that
 *  as a skipped run rather than aborting the batch). */
export function findDiscoverer(id: string): DiscovererDefinition | null {
  return DISCOVERERS.find((d) => d.id === id) ?? null;
}

/** All discoverers compatible with a given integration type. The
 *  cron iterates the active integrations and looks up which
 *  discoverers fire for each. */
export function discoverersForIntegration(
  integrationType: string,
): DiscovererDefinition[] {
  return DISCOVERERS.filter((d) => d.integration_type === integrationType);
}
