// Terraform state → target extractor.
//
// Reads a `terraform.tfstate` JSON file (v4 format — current as of TF
// 1.x) and pulls out every resource that maps to a scannable target.
// The customer's CMDB-replacement story: they already model their
// infra in Terraform; we shouldn't make them re-enter the same list
// in our UI.
//
// We deliberately don't cover every Terraform provider — just the
// resource types that produce externally-reachable URLs. Adding a
// provider is one entry in EXTRACTORS plus a small mapper function.
//
// Output shape matches what `bulk_upsert_targets` expects, so the
// route handler can forward straight to the existing RPC.

export interface TerraformTarget {
  name: string;
  type:
    | 'web_application'
    | 'api'
    | 'repository'
    | 'container_image'
    | 'cloud_account'
    | 'domain'
    | 'ip_address'
    | 'local_code';
  value: string;
  external_id?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  scan_frequency?: 'manual' | 'daily' | 'weekly' | 'monthly';
}

interface TfStateResource {
  type?: string;
  name?: string;
  module?: string;
  provider?: string;
  instances?: Array<{
    attributes?: Record<string, unknown>;
    index_key?: unknown;
  }>;
}

interface TfState {
  version?: number;
  terraform_version?: string;
  resources?: TfStateResource[];
}

interface Extractor {
  /** Terraform resource type to match against. */
  resourceType: string;
  /** Convert a resource instance's attributes into one or more targets.
   *  Return [] when the instance isn't externally reachable. */
  extract: (
    attrs: Record<string, unknown>,
    ctx: { resourceName: string; module: string | undefined },
  ) => TerraformTarget[];
}

const EXTRACTORS: Extractor[] = [
  // ---- AWS ELB v2 (ALB / NLB) ---------------------------------
  {
    resourceType: 'aws_lb',
    extract(attrs, ctx) {
      if (attrs.internal === true) return []; // internal LBs aren't externally reachable
      const dns = attrs.dns_name as string | undefined;
      if (!dns) return [];
      return [
        {
          name: (attrs.name as string) ?? ctx.resourceName,
          type: 'web_application',
          value: `https://${dns}`,
          external_id: `terraform:aws_lb:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          metadata: {
            terraform_resource_type: 'aws_lb',
            terraform_module: ctx.module ?? 'root',
            aws_arn: attrs.arn,
            aws_region: attrs.region ?? attrs.availability_zone,
            lb_type: attrs.load_balancer_type ?? 'application',
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },
  // Legacy aws_alb alias still in use in some states.
  {
    resourceType: 'aws_alb',
    extract(attrs, ctx) {
      return EXTRACTORS[0].extract(attrs, ctx);
    },
  },

  // ---- AWS API Gateway v1 (REST) ------------------------------
  {
    resourceType: 'aws_api_gateway_rest_api',
    extract(attrs, ctx) {
      const id = attrs.id as string | undefined;
      const region = (attrs.region as string | undefined) ?? deriveRegionFromArn(attrs.arn);
      if (!id || !region) return [];
      // Base URL; the customer adds the stage suffix later.
      const url = `https://${id}.execute-api.${region}.amazonaws.com`;
      return [
        {
          name: (attrs.name as string) ?? ctx.resourceName,
          type: 'api',
          value: url,
          external_id: `terraform:aws_api_gateway_rest_api:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          description: attrs.description as string | undefined,
          metadata: {
            terraform_resource_type: 'aws_api_gateway_rest_api',
            terraform_module: ctx.module ?? 'root',
            aws_api_id: id,
            aws_region: region,
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },

  // ---- AWS API Gateway v2 (HTTP / WebSocket) ------------------
  {
    resourceType: 'aws_apigatewayv2_api',
    extract(attrs, ctx) {
      const endpoint = attrs.api_endpoint as string | undefined;
      if (!endpoint) return [];
      return [
        {
          name: (attrs.name as string) ?? ctx.resourceName,
          type: 'api',
          value: endpoint,
          external_id: `terraform:aws_apigatewayv2_api:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          description: attrs.description as string | undefined,
          metadata: {
            terraform_resource_type: 'aws_apigatewayv2_api',
            terraform_module: ctx.module ?? 'root',
            protocol_type: attrs.protocol_type,
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },

  // ---- GCP Cloud Run service ----------------------------------
  {
    resourceType: 'google_cloud_run_service',
    extract(attrs, ctx) {
      const status = attrs.status as Array<{ url?: string }> | undefined;
      const url = status?.[0]?.url;
      if (!url) return [];
      // Cloud Run private services are gated by IAM not by URL, so we
      // surface all of them and let the customer reject internal ones
      // during bulk approval.
      return [
        {
          name: (attrs.name as string) ?? ctx.resourceName,
          type: 'web_application',
          value: url,
          external_id: `terraform:google_cloud_run_service:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          metadata: {
            terraform_resource_type: 'google_cloud_run_service',
            terraform_module: ctx.module ?? 'root',
            project: attrs.project,
            location: attrs.location,
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },

  // ---- GCP Cloud Run v2 ---------------------------------------
  {
    resourceType: 'google_cloud_run_v2_service',
    extract(attrs, ctx) {
      const uri = attrs.uri as string | undefined;
      if (!uri) return [];
      return [
        {
          name: (attrs.name as string) ?? ctx.resourceName,
          type: 'web_application',
          value: uri,
          external_id: `terraform:google_cloud_run_v2_service:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          metadata: {
            terraform_resource_type: 'google_cloud_run_v2_service',
            terraform_module: ctx.module ?? 'root',
            project: attrs.project,
            location: attrs.location,
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },

  // ---- Azure App Service / Function App ------------------------
  {
    resourceType: 'azurerm_linux_web_app',
    extract: azureAppServiceExtractor('azurerm_linux_web_app'),
  },
  {
    resourceType: 'azurerm_windows_web_app',
    extract: azureAppServiceExtractor('azurerm_windows_web_app'),
  },
  {
    resourceType: 'azurerm_linux_function_app',
    extract: azureAppServiceExtractor('azurerm_linux_function_app'),
  },
  {
    resourceType: 'azurerm_windows_function_app',
    extract: azureAppServiceExtractor('azurerm_windows_function_app'),
  },

  // ---- Kubernetes Service (LoadBalancer) -----------------------
  {
    resourceType: 'kubernetes_service',
    extract(attrs, ctx) {
      const spec = (attrs.spec as Array<Record<string, unknown>> | undefined)?.[0];
      const status = (attrs.status as Array<Record<string, unknown>> | undefined)?.[0];
      if (!spec || spec.type !== 'LoadBalancer') return [];
      const lb = (status?.load_balancer as Array<Record<string, unknown>> | undefined)?.[0];
      const ingress = (lb?.ingress as Array<Record<string, unknown>> | undefined)?.[0];
      const host =
        (ingress?.hostname as string | undefined) ??
        (ingress?.ip as string | undefined);
      if (!host) return [];
      const metadata = (attrs.metadata as Array<Record<string, unknown>> | undefined)?.[0];
      return [
        {
          name: (metadata?.name as string) ?? ctx.resourceName,
          type: 'web_application',
          value: `https://${host}`,
          external_id: `terraform:kubernetes_service:${ctx.module ?? 'root'}:${ctx.resourceName}`,
          metadata: {
            terraform_resource_type: 'kubernetes_service',
            terraform_module: ctx.module ?? 'root',
            namespace: metadata?.namespace,
            tags: attrsTags(attrs),
          },
        },
      ];
    },
  },

  // ---- Kubernetes Ingress -------------------------------------
  // One Ingress can declare N hostnames; we emit one target per host.
  {
    resourceType: 'kubernetes_ingress_v1',
    extract(attrs, ctx) {
      const spec = (attrs.spec as Array<Record<string, unknown>> | undefined)?.[0];
      const rules = (spec?.rule as Array<Record<string, unknown>> | undefined) ?? [];
      const tlsHosts = new Set<string>();
      for (const tls of (spec?.tls as Array<Record<string, unknown>> | undefined) ?? []) {
        for (const h of (tls.hosts as string[] | undefined) ?? []) tlsHosts.add(h);
      }
      const metadata = (attrs.metadata as Array<Record<string, unknown>> | undefined)?.[0];
      const ns = (metadata?.namespace as string | undefined) ?? 'default';
      const name = (metadata?.name as string | undefined) ?? ctx.resourceName;

      return rules
        .map((r) => r.host as string | undefined)
        .filter((h): h is string => !!h)
        .map((host) => ({
          name: `${name} · ${host}`,
          type: 'web_application' as const,
          value: `${tlsHosts.has(host) ? 'https' : 'http'}://${host}`,
          external_id: `terraform:kubernetes_ingress_v1:${ctx.module ?? 'root'}:${ctx.resourceName}:${host}`,
          metadata: {
            terraform_resource_type: 'kubernetes_ingress_v1',
            terraform_module: ctx.module ?? 'root',
            namespace: ns,
            ingress_name: name,
          },
        }));
    },
  },
];

/** Parse a Terraform state JSON blob (v4 format) and return every
 *  scannable target we recognised. Unknown resource types are
 *  silently skipped — the parse function never throws for unknown
 *  shapes. */
export function parseTerraformState(text: string): {
  targets: TerraformTarget[];
  summary: { total_resources: number; matched: number; skipped_types: Record<string, number> };
} {
  let state: TfState;
  try {
    state = JSON.parse(text) as TfState;
  } catch {
    throw new Error('Terraform state is not valid JSON');
  }
  if (state.version !== 4 && state.version !== undefined) {
    // Older state versions are rare in modern Terraform but we keep
    // them parseable for compatibility.
  }
  if (!Array.isArray(state.resources)) {
    throw new Error('Terraform state has no `resources` array — wrong file?');
  }

  const targets: TerraformTarget[] = [];
  const skipped: Record<string, number> = {};
  let totalInstances = 0;

  for (const res of state.resources) {
    const matcher = EXTRACTORS.find((e) => e.resourceType === res.type);
    if (!matcher) {
      if (res.type) skipped[res.type] = (skipped[res.type] ?? 0) + 1;
      continue;
    }
    for (const inst of res.instances ?? []) {
      totalInstances += 1;
      const attrs = inst.attributes ?? {};
      const extracted = matcher.extract(attrs, {
        resourceName: res.name ?? 'unnamed',
        module: res.module,
      });
      targets.push(...extracted);
    }
  }

  return {
    targets,
    summary: {
      total_resources: state.resources.length,
      matched: targets.length,
      skipped_types: skipped,
    },
  };
}

function azureAppServiceExtractor(
  rt: string,
): Extractor['extract'] {
  return (attrs, ctx) => {
    const host = attrs.default_hostname as string | undefined;
    if (!host) return [];
    return [
      {
        name: (attrs.name as string) ?? ctx.resourceName,
        type: 'web_application',
        value: `https://${host}`,
        external_id: `terraform:${rt}:${ctx.module ?? 'root'}:${ctx.resourceName}`,
        metadata: {
          terraform_resource_type: rt,
          terraform_module: ctx.module ?? 'root',
          azure_resource_id: attrs.id,
          location: attrs.location,
          tags: attrsTags(attrs),
        },
      },
    ];
  };
}

/** Extract Terraform's `tags = { ... }` map as a plain object so it
 *  survives the trip through the wrapper's `targets.metadata` JSONB. */
function attrsTags(attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  const t = attrs.tags;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    return t as Record<string, unknown>;
  }
  return undefined;
}

/** Recover region from an AWS ARN (the API Gateway state doesn't
 *  always include a `region` attribute but ARNs always carry it). */
function deriveRegionFromArn(arn: unknown): string | undefined {
  if (typeof arn !== 'string') return undefined;
  const m = arn.match(/^arn:aws[a-z0-9-]*:[a-z0-9-]+:([a-z0-9-]+):/);
  return m?.[1];
}
