// Domain subdomain discoverer.
//
// Enumerates subdomains of a configured apex domain via Certificate
// Transparency logs (crt.sh) and proposes each live one as a
// web_application target. No AWS / cloud credentials needed; the
// "integration" is a wrapper-side stub whose vault payload is just
// `{"apex": "<host>"}`.
//
// Why crt.sh: CT logs are public + comprehensive for any TLS cert
// ever issued (Let's Encrypt, AWS ACM, GoDaddy, internal CAs that
// register), free, and don't require us to ship a wordlist or run
// dictionary lookups against the customer's DNS. Most real
// subdomains end up with a TLS cert eventually, so coverage is high.
//
// We dedupe (case-insensitive), filter out wildcard certs, filter
// out the apex itself, and cap at 500 subdomains per run to keep
// the discovered_assets table from filling up on a long-tail
// internal-CA domain.

import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

interface DomainCreds {
  apex?: string;
}

interface CrtShRow {
  // crt.sh returns a JSON array; common_name and name_value carry
  // the hostnames. name_value can be a newline-separated list of
  // SANs for a single cert.
  common_name?: string;
  name_value?: string;
}

const SUBDOMAIN_CAP = 500;

export const domainSubdomainDiscoverer: DiscovererDefinition = {
  id: 'domain_subdomains',
  provider: 'domain',
  display_name: 'Domain · subdomain enumeration',
  description:
    'Enumerates subdomains of the configured apex domain via public ' +
    'Certificate Transparency logs (crt.sh). No DNS probing of the ' +
    'customer\'s own infrastructure; passive recon only. Each live ' +
    'subdomain is proposed as a web_application target.',
  integration_type: 'domain',
  produces: ['web_application'],
  default_frequency_minutes: 1440, // 24h
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as DomainCreds;
    const apex = (creds.apex ?? '').trim().toLowerCase();
    if (!apex) {
      throw new Error('domain integration vault is missing { apex }');
    }
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(apex)) {
      throw new Error(`apex "${apex}" is not a valid domain`);
    }

    // crt.sh's JSON output. We use HTTPS + a short timeout — the
    // service can be slow under load.
    const url = `https://crt.sh/?q=%25.${encodeURIComponent(apex)}&output=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let rows: CrtShRow[];
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'tensorshield-asset-discovery/1.0' },
      });
      if (!res.ok) {
        throw new Error(`crt.sh returned ${res.status}`);
      }
      const text = await res.text();
      // crt.sh occasionally serves NaN inside the JSON for "id" — guard
      // the parse.
      try {
        rows = JSON.parse(text) as CrtShRow[];
      } catch {
        throw new Error('crt.sh returned non-JSON body');
      }
    } finally {
      clearTimeout(timer);
    }

    // Flatten common_name + name_value, dedupe, filter wildcards / apex.
    const seen = new Set<string>();
    for (const row of rows) {
      for (const raw of [row.common_name, ...(row.name_value ?? '').split(/\r?\n/)]) {
        const host = (raw ?? '').trim().toLowerCase();
        if (!host) continue;
        if (host.startsWith('*.')) continue; // wildcard cert, not a real host
        if (host === apex) continue; // the apex itself
        if (!host.endsWith(`.${apex}`)) continue; // unrelated SAN
        if (!/^[a-z0-9.-]+$/.test(host)) continue;
        seen.add(host);
        if (seen.size >= SUBDOMAIN_CAP) break;
      }
      if (seen.size >= SUBDOMAIN_CAP) break;
    }

    const assets: DiscoveredAsset[] = Array.from(seen).map((host) => {
      const depth = host.split('.').length - apex.split('.').length;
      const confidence: DiscoveredAsset['confidence'] =
        depth <= 1 ? 'high' : depth <= 2 ? 'medium' : 'low';
      return {
        asset_type: 'web_application',
        canonical_id: `domain:${host}`,
        display_name: host,
        attributes: {
          value: `https://${host}`,
          upstream_url: `https://crt.sh/?q=${encodeURIComponent(host)}`,
          tags: [`apex:${apex}`, `depth:${depth}`, 'source:crt.sh'],
          integration_id: ctx.integrationId,
        },
        suggested_config: {
          scan_mode: 'quick',
          scan_frequency: depth === 1 ? 'weekly' : 'monthly',
          integration_id: ctx.integrationId,
        },
        confidence,
      };
    });

    return {
      assets,
      partial_error:
        seen.size >= SUBDOMAIN_CAP
          ? `Found ${SUBDOMAIN_CAP}+ subdomains under "${apex}" — truncated. Consider connecting a narrower apex or filtering after import.`
          : undefined,
    };
  },
};
