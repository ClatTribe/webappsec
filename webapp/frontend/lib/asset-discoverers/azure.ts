// Azure public resources discoverer.
//
// Enumerates the public attack surface of a connected Azure
// subscription via the Azure ARM SDKs and proposes each public
// resource as a target. Covers the edge points a customer actually
// exposes:
//
//   - App Service web apps + Function Apps with public ingress
//   - Public IP addresses bound to load balancers / VMs
//   - Front Door endpoints
//
// Credential model matches the worker's existing Azure resolution
// (worker/src/strix_worker/credentials.py):
//   vault payload: { client_id, client_secret, tenant_id }
//   metadata:      { subscription_id }
//
// The SP needs `Reader` on the target subscription for the listing
// calls to succeed.

import { ClientSecretCredential } from '@azure/identity';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { NetworkManagementClient } from '@azure/arm-network';
import { CdnManagementClient } from '@azure/arm-cdn';
import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

interface AzureCreds {
  client_id?: string;
  client_secret?: string;
  tenant_id?: string;
}

export const azureResourcesDiscoverer: DiscovererDefinition = {
  id: 'azure_resources',
  provider: 'azure',
  display_name: 'Azure public-facing resources',
  description:
    'Enumerates the public attack surface of a connected Azure ' +
    'subscription — App Service web apps + Function Apps, public IPs ' +
    'bound to load balancers / VMs, and Front Door endpoints. Each ' +
    'becomes a web_application target with auto-suggested scan config.',
  integration_type: 'azure',
  produces: ['web_application'],
  default_frequency_minutes: 1440,
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as AzureCreds;
    const meta = ctx.integrationMetadata as { subscription_id?: string };
    if (!creds.client_id || !creds.client_secret || !creds.tenant_id) {
      throw new Error(
        'azure integration vault is missing one of { client_id, client_secret, tenant_id }',
      );
    }
    const subscriptionId = meta.subscription_id;
    if (!subscriptionId) {
      throw new Error(
        'azure integration metadata is missing subscription_id (the SDK requires it for resource listing)',
      );
    }

    const credential = new ClientSecretCredential(
      creds.tenant_id,
      creds.client_id,
      creds.client_secret,
    );

    const assets: DiscoveredAsset[] = [];
    const errors: string[] = [];

    // --- App Service web apps + Function Apps ---------------------
    // listAll() pages through the whole subscription. For
    // organisations with 1000s of apps this would saturate; we cap
    // at 500 (consistent with other discoverers).
    try {
      const webClient = new WebSiteManagementClient(credential, subscriptionId);
      let count = 0;
      for await (const site of webClient.webApps.list()) {
        if (count >= 500) break;
        count += 1;
        // hostNames carries the default + custom hostnames; the first
        // one is the auto-generated <name>.azurewebsites.net. Filter
        // to running sites with at least one host.
        const host = site.defaultHostName ?? site.hostNames?.[0];
        if (!host) continue;
        const state = site.state ?? 'unknown';
        if (state === 'Stopped') continue;
        // kind = 'app' (web app), 'functionapp', or compound like
        // 'app,linux'. We treat both as web_application; the scan
        // mode hint differs slightly so the wrapper can hint Function
        // Apps as more API-y in the suggested config.
        const isFunction = (site.kind ?? '').includes('functionapp');
        assets.push({
          asset_type: 'web_application',
          canonical_id: `azure:webapp/${subscriptionId}/${site.id?.split('/').pop()}`,
          display_name: `${site.name ?? host} (${isFunction ? 'Function App' : 'App Service'} · ${site.location ?? 'unknown'})`,
          attributes: {
            value: `https://${host}`,
            upstream_url: `https://portal.azure.com/#@/resource${site.id ?? ''}`,
            tags: [
              `region:${site.location ?? 'unknown'}`,
              isFunction ? 'azure:function-app' : 'azure:app-service',
              ...(site.kind ? [`kind:${site.kind}`] : []),
            ],
            subscription_id: subscriptionId,
            resource_id: site.id,
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
      errors.push(`appservice: ${e instanceof Error ? e.message : String(e)}`);
    }

    // --- Public IPs (LB / VM front-ends) --------------------------
    // A public IP only matters for DAST if it has an FQDN or a
    // running service behind it. We list everything but only propose
    // the ones with a DNS name set; bare-IP public addresses don't
    // give us a hostname to scan against and are usually L4.
    try {
      const netClient = new NetworkManagementClient(credential, subscriptionId);
      let count = 0;
      for await (const pip of netClient.publicIPAddresses.listAll()) {
        if (count >= 500) break;
        count += 1;
        const fqdn = pip.dnsSettings?.fqdn;
        if (!fqdn) continue; // skip bare IPs — no host to DAST against
        if (pip.publicIPAllocationMethod && pip.ipAddress === undefined) {
          continue; // unallocated, nothing to scan
        }
        assets.push({
          asset_type: 'web_application',
          canonical_id: `azure:pip/${subscriptionId}/${pip.id?.split('/').pop()}`,
          display_name: `${pip.name ?? fqdn} (Public IP · ${pip.location ?? 'unknown'})`,
          attributes: {
            value: `https://${fqdn}`,
            upstream_url: `https://portal.azure.com/#@/resource${pip.id ?? ''}`,
            tags: [
              `region:${pip.location ?? 'unknown'}`,
              'azure:public-ip',
              ...(pip.publicIPAddressVersion ? [`ip:${pip.publicIPAddressVersion}`] : []),
            ],
            subscription_id: subscriptionId,
            resource_id: pip.id,
            ip_address: pip.ipAddress,
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
      errors.push(`network: ${e instanceof Error ? e.message : String(e)}`);
    }

    // --- Front Door endpoints (CDN with public hostnames) ---------
    // The Front Door + CDN APIs are unified under the CDN ARM
    // surface. We list custom domains across all profiles in the sub.
    try {
      const cdnClient = new CdnManagementClient(credential, subscriptionId);
      const profiles: Array<{ id?: string; name?: string }> = [];
      let pCount = 0;
      for await (const p of cdnClient.profiles.list()) {
        if (pCount >= 50) break;
        pCount += 1;
        if (p.name && p.id) profiles.push({ id: p.id, name: p.name });
      }
      // Per-profile endpoint listing. profiles.list returns the
      // profiles; profile name + parent resource group are required
      // for endpoint enumeration.
      await Promise.all(
        profiles.map(async (profile) => {
          if (!profile.id || !profile.name) return;
          const rg = (profile.id.match(/\/resourceGroups\/([^/]+)\//) ?? [])[1];
          if (!rg) return;
          try {
            for await (const ep of cdnClient.endpoints.listByProfile(
              rg,
              profile.name!,
            )) {
              const host = ep.hostName;
              if (!host) continue;
              assets.push({
                asset_type: 'web_application',
                canonical_id: `azure:cdn/${subscriptionId}/${ep.id?.split('/').pop()}`,
                display_name: `${ep.name ?? host} (Front Door / CDN)`,
                attributes: {
                  value: `https://${host}`,
                  upstream_url: `https://portal.azure.com/#@/resource${ep.id ?? ''}`,
                  tags: [
                    `region:${ep.location ?? 'unknown'}`,
                    'azure:cdn',
                  ],
                  subscription_id: subscriptionId,
                  resource_id: ep.id,
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
            errors.push(
              `cdn/profile/${profile.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }),
      );
    } catch (e) {
      errors.push(`cdn: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      assets,
      partial_error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};
