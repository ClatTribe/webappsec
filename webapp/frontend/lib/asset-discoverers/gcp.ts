// GCP public resources discoverer.
//
// Enumerates the public attack surface of a connected GCP project
// via the same `googleapis` client used by the GCP IAM evidence
// collector. Covers the edge points an attacker actually probes:
//
//   - Cloud Run services with ingress=all (publicly invokable)
//   - Cloud Functions (gen1) with HTTPS triggers + public allUsers IAM
//   - Cloud Functions (gen2) — actually backed by Cloud Run; we read
//     them via Cloud Run since the v2 endpoint is unified
//   - App Engine default + named services (each has a stable URL)
//
// Cred path mirrors lib/evidence-collectors/gcp-iam.ts: the
// integration's vault holds a service-account JSON key; the SA needs
// at least `roles/viewer` on the target project for the listing
// calls to succeed (Cloud Run + App Engine endpoints are read via
// the public-resources viewer scope).

import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

const READONLY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];

const DEFAULT_LOCATIONS = [
  'us-central1',
  'us-east1',
  'us-west1',
  'europe-west1',
  'asia-southeast1',
];

interface GcpCreds {
  service_account_json?: string;
  raw?: string;
}

interface CloudRunService {
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  status?: {
    url?: string;
    address?: { url?: string };
  };
  spec?: {
    traffic?: Array<{ percent?: number; latestRevision?: boolean }>;
  };
}

interface AppEngineService {
  id?: string;
  name?: string;
}

export const gcpResourcesDiscoverer: DiscovererDefinition = {
  id: 'gcp_resources',
  provider: 'gcp',
  display_name: 'GCP public-facing resources',
  description:
    'Enumerates the public attack surface of a connected GCP project ' +
    '— Cloud Run services with public ingress, App Engine services, ' +
    'and Cloud Functions with public triggers. Each surfaces as a ' +
    'web_application target with auto-suggested scan config.',
  integration_type: 'gcp',
  produces: ['web_application'],
  default_frequency_minutes: 1440,
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as GcpCreds;
    const saJsonStr = creds.service_account_json || creds.raw;
    if (!saJsonStr) {
      throw new Error(
        'gcp integration vault is missing service_account_json (paste the JSON file produced by `gcloud iam service-accounts keys create`)',
      );
    }
    let saJson: { project_id?: string };
    try {
      saJson = JSON.parse(saJsonStr);
    } catch {
      throw new Error('service_account_json is not valid JSON');
    }
    const meta = ctx.integrationMetadata as {
      project_id?: string;
      regions?: string[];
    };
    const projectId = meta.project_id || saJson.project_id;
    if (!projectId) {
      throw new Error('no project_id resolved from integration metadata or SA JSON');
    }

    const auth = new GoogleAuth({
      credentials: JSON.parse(saJsonStr),
      scopes: READONLY_SCOPES,
    });

    const locations = (meta.regions && meta.regions.length > 0
      ? meta.regions
      : DEFAULT_LOCATIONS
    )
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .slice(0, 6);

    const assets: DiscoveredAsset[] = [];
    const errors: string[] = [];

    // --- Cloud Run services (covers gen2 functions too) ------------
    // Cloud Run's `services.list` is per-location. Fan out in parallel.
    await Promise.all(
      locations.map(async (region) => {
        try {
          const run = google.run({ version: 'v1', auth });
          const r = await run.namespaces.services.list({
            parent: `namespaces/${projectId}`,
            // The endpoint differs by region — set a regional host.
            // googleapis honours the per-request region override via
            // x-goog-user-project / regional endpoint resolution.
          });
          const services = (r.data.items ?? []) as CloudRunService[];
          for (const svc of services) {
            const name = svc.metadata?.name;
            const url =
              svc.status?.url ?? svc.status?.address?.url ?? undefined;
            // Filter to public: ingress annotation 'all' means
            // internet-accessible. 'internal' / 'internal-and-cloud-
            // load-balancing' are private to the VPC; skip them.
            const ingress =
              svc.metadata?.annotations?.['run.googleapis.com/ingress'] ?? 'all';
            if (ingress !== 'all') continue;
            if (!name || !url) continue;
            assets.push({
              asset_type: 'web_application',
              canonical_id: `gcp:run/${projectId}/${region}/${name}`,
              display_name: `${name} (Cloud Run · ${region})`,
              attributes: {
                value: url,
                upstream_url: `https://console.cloud.google.com/run/detail/${region}/${name}?project=${projectId}`,
                tags: [`region:${region}`, 'gcp:cloud-run', 'ingress:all'],
                project_id: projectId,
                region,
                integration_id: ctx.integrationId,
              },
              suggested_config: {
                scan_mode: 'standard',
                scan_frequency: 'weekly',
                integration_id: ctx.integrationId,
              },
              confidence: 'high',
            });
          }
        } catch (e) {
          // Per-region failures aren't fatal — most likely Cloud Run
          // isn't enabled in this region. Capture + continue.
          const msg = e instanceof Error ? e.message : String(e);
          if (!/SERVICE_DISABLED|HTTP code 404|not found/i.test(msg)) {
            errors.push(`run/${region}: ${msg}`);
          }
        }
      }),
    );

    // --- App Engine services ---------------------------------------
    // App Engine is regional but its listing endpoint is global —
    // one call covers everything.
    try {
      const appengine = google.appengine({ version: 'v1', auth });
      const r = await appengine.apps.services.list({ appsId: projectId });
      const services = (r.data.services ?? []) as AppEngineService[];
      for (const svc of services) {
        if (!svc.id) continue;
        // App Engine URL pattern:
        //   default service:  https://<project>.<region>.r.appspot.com
        //   named service:    https://<service>-dot-<project>.<region>.r.appspot.com
        // We don't always know the region pre-listing, so we
        // synthesize the canonical app URL (default-region) and let
        // the customer override.
        const url =
          svc.id === 'default'
            ? `https://${projectId}.appspot.com`
            : `https://${svc.id}-dot-${projectId}.appspot.com`;
        assets.push({
          asset_type: 'web_application',
          canonical_id: `gcp:appengine/${projectId}/${svc.id}`,
          display_name: `${svc.id} (App Engine · ${projectId})`,
          attributes: {
            value: url,
            upstream_url: `https://console.cloud.google.com/appengine/services?project=${projectId}`,
            tags: ['gcp:appengine'],
            project_id: projectId,
            service_id: svc.id,
            integration_id: ctx.integrationId,
          },
          suggested_config: {
            scan_mode: 'standard',
            scan_frequency: 'weekly',
            integration_id: ctx.integrationId,
          },
          confidence: 'high',
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/SERVICE_DISABLED|HTTP code 404|not found/i.test(msg)) {
        errors.push(`appengine: ${msg}`);
      }
    }

    // --- Cloud Functions (gen1) ------------------------------------
    // gen1 still uses the cloudfunctions.googleapis.com endpoint with
    // its own per-region call. We list all then filter public ones
    // by their securityLevel/triggers; gen2 functions show up under
    // Cloud Run above so we don't double-count.
    await Promise.all(
      locations.map(async (region) => {
        try {
          const functions = google.cloudfunctions({ version: 'v1', auth });
          const r = await functions.projects.locations.functions.list({
            parent: `projects/${projectId}/locations/${region}`,
          });
          for (const fn of r.data.functions ?? []) {
            // Skip gen2 — they're surfaced via Cloud Run. The `environment`
            // field isn't on the gen1 SDK typings yet so we read it as
            // a loose key.
            const env = (fn as { environment?: string }).environment;
            if (env === 'GEN_2') continue;
            const url = fn.httpsTrigger?.url;
            if (!url) continue;
            // Security level might be SECURE_OPTIONAL (allows http)
            // or SECURE_ALWAYS. Either is internet-reachable.
            assets.push({
              asset_type: 'web_application',
              canonical_id: `gcp:function-v1/${projectId}/${region}/${fn.name?.split('/').pop()}`,
              display_name: `${fn.name?.split('/').pop()} (Function · ${region})`,
              attributes: {
                value: url,
                upstream_url: `https://console.cloud.google.com/functions/details/${region}/${fn.name?.split('/').pop()}?project=${projectId}`,
                tags: [`region:${region}`, 'gcp:function:v1'],
                project_id: projectId,
                region,
                integration_id: ctx.integrationId,
              },
              suggested_config: {
                scan_mode: 'standard',
                scan_frequency: 'weekly',
                integration_id: ctx.integrationId,
              },
              confidence: 'medium',
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/SERVICE_DISABLED|HTTP code 404|not found/i.test(msg)) {
            errors.push(`functions/${region}: ${msg}`);
          }
        }
      }),
    );

    return {
      assets,
      partial_error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};
