// Kubernetes resources discoverer.
//
// Enumerates the public ingress surface of a connected Kubernetes
// cluster via the cluster's API server. Covers the only objects
// that map to externally-reachable URLs:
//
//   - Services of type=LoadBalancer with a resolved external IP /
//     hostname (status.loadBalancer.ingress[*])
//   - Ingress resources with rules — one entry per host
//
// We deliberately don't enumerate ClusterIP services (internal-only)
// or NodePort services (require knowing node external IPs and most
// orgs front them with an LB anyway). CSPM tooling covers RBAC /
// pod-security; this discoverer is strictly about externally-
// reachable HTTP endpoints.
//
// Credential model matches the worker's existing K8s resolution
// (worker/src/strix_worker/credentials.py): vault payload is the
// raw kubeconfig under `kubeconfig` (or `raw` for the legacy alias).
// We load it via `loadFromString`; no file is ever written to disk.

import * as k8s from '@kubernetes/client-node';
import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

interface K8sCreds {
  kubeconfig?: string;
  raw?: string;
}

export const k8sResourcesDiscoverer: DiscovererDefinition = {
  id: 'k8s_resources',
  provider: 'k8s',
  display_name: 'Kubernetes externally-reachable services',
  description:
    'Enumerates the public ingress surface of a connected Kubernetes ' +
    'cluster — LoadBalancer-type Services with resolved external IPs, ' +
    'and Ingress resources with host rules. Each becomes a ' +
    'web_application target with auto-suggested scan config.',
  integration_type: 'k8s',
  produces: ['web_application'],
  default_frequency_minutes: 1440,
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as K8sCreds;
    const kubeconfigStr = creds.kubeconfig || creds.raw;
    if (!kubeconfigStr) {
      throw new Error('k8s integration vault is missing { kubeconfig } (raw YAML)');
    }

    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromString(kubeconfigStr);
    } catch (e) {
      throw new Error(
        `failed to parse kubeconfig: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const netApi = kc.makeApiClient(k8s.NetworkingV1Api);

    const assets: DiscoveredAsset[] = [];
    const errors: string[] = [];
    const clusterName = kc.getCurrentCluster()?.name ?? 'cluster';

    // --- LoadBalancer Services across all namespaces ---------------
    try {
      const out = (await coreApi.listServiceForAllNamespaces()) as unknown as {
        items?: unknown[];
      };
      const items = (out.items ?? []) as Array<{
        metadata?: {
          name?: string;
          namespace?: string;
          uid?: string;
          annotations?: Record<string, string>;
        };
        spec?: { type?: string; ports?: Array<{ port?: number; protocol?: string }> };
        status?: {
          loadBalancer?: {
            ingress?: Array<{ ip?: string; hostname?: string }>;
          };
        };
      }>;
      for (const svc of items) {
        if (svc.spec?.type !== 'LoadBalancer') continue;
        const ingress = svc.status?.loadBalancer?.ingress ?? [];
        if (ingress.length === 0) continue; // LB still provisioning
        // Prefer the cloud-allocated hostname (ELB DNS, AKS, etc.)
        // over the IP — DAST against an IP often hits HTTPS SNI
        // mismatches.
        const target =
          ingress[0]?.hostname ?? ingress[0]?.ip ?? null;
        if (!target) continue;
        const ports = svc.spec?.ports ?? [];
        const https = ports.some((p) => p.port === 443);
        const http = ports.some((p) => p.port === 80);
        const scheme = https ? 'https' : http ? 'http' : 'https';
        const url = `${scheme}://${target}`;
        const ns = svc.metadata?.namespace ?? 'default';
        const name = svc.metadata?.name ?? 'unknown';
        assets.push({
          asset_type: 'web_application',
          canonical_id: `k8s:service/${clusterName}/${ns}/${name}`,
          display_name: `${name}.${ns} (LB · ${clusterName})`,
          attributes: {
            value: url,
            tags: [`cluster:${clusterName}`, `ns:${ns}`, 'k8s:loadbalancer'],
            namespace: ns,
            service_name: name,
            cluster: clusterName,
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
      errors.push(`services: ${e instanceof Error ? e.message : String(e)}`);
    }

    // --- Ingress rules across all namespaces -----------------------
    // One Ingress can carry N hostnames (the `rules[*].host` array);
    // we propose one asset per unique host. Backends are usually
    // ClusterIP services that the ingress routes to — we don't
    // surface the backends as separate assets, only the public host.
    try {
      const out = (await netApi.listIngressForAllNamespaces()) as unknown as {
        items?: unknown[];
      };
      const items = (out.items ?? []) as Array<{
        metadata?: { name?: string; namespace?: string };
        spec?: {
          tls?: Array<{ hosts?: string[] }>;
          rules?: Array<{ host?: string }>;
        };
        status?: {
          loadBalancer?: {
            ingress?: Array<{ hostname?: string; ip?: string }>;
          };
        };
      }>;
      for (const ing of items) {
        const ns = ing.metadata?.namespace ?? 'default';
        const name = ing.metadata?.name ?? 'unknown';
        const tlsHosts = new Set(
          (ing.spec?.tls ?? []).flatMap((t) => t.hosts ?? []),
        );
        const hosts = new Set<string>();
        for (const rule of ing.spec?.rules ?? []) {
          if (rule.host) hosts.add(rule.host);
        }
        // If there are no rule hosts but the ingress has an LB
        // status (default backend pattern), surface the LB.
        if (hosts.size === 0) {
          const lb = ing.status?.loadBalancer?.ingress?.[0];
          if (lb?.hostname) hosts.add(lb.hostname);
          else if (lb?.ip) hosts.add(lb.ip);
        }
        for (const host of hosts) {
          const scheme = tlsHosts.has(host) ? 'https' : 'http';
          const url = `${scheme}://${host}`;
          assets.push({
            asset_type: 'web_application',
            canonical_id: `k8s:ingress/${clusterName}/${ns}/${name}/${host}`,
            display_name: `${host} (Ingress · ${name}.${ns})`,
            attributes: {
              value: url,
              tags: [
                `cluster:${clusterName}`,
                `ns:${ns}`,
                'k8s:ingress',
                ...(tlsHosts.has(host) ? ['tls'] : []),
              ],
              namespace: ns,
              ingress_name: name,
              host,
              cluster: clusterName,
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
      }
    } catch (e) {
      errors.push(`ingress: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      assets,
      partial_error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};
