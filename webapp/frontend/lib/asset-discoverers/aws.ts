// AWS resources discoverer.
//
// Enumerates the public attack surface of a connected AWS account
// and proposes each scannable resource as a target. Covers the
// classic edge points auditors and attackers care about:
//
//   - Application / Network Load Balancers with internet-facing scheme
//   - API Gateway REST APIs (v1) — public endpoints
//   - API Gateway HTTP / WebSocket APIs (v2)
//   - Lambda function URLs configured as AWS_IAM=NONE
//
// One AWS region per run (cap: 6 most common regions). Operators who
// need additional regions add them to integrations.metadata.regions
// as a string array; defaults below cover ~95% of real workloads.
//
// Credentials path matches lib/evidence-collectors/aws-iam.ts: prefer
// role_arn + STS AssumeRole, fall back to long-lived access keys.

import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  APIGatewayClient,
  GetRestApisCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetApisCommand,
} from '@aws-sdk/client-apigatewayv2';
import {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionUrlConfigCommand,
} from '@aws-sdk/client-lambda';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type {
  DiscovererContext,
  DiscovererDefinition,
  DiscovererResult,
  DiscoveredAsset,
} from './types';

interface RuntimeAwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface AwsCreds {
  role_arn?: string;
  external_id?: string;
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
}

const DEFAULT_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];

export const awsResourcesDiscoverer: DiscovererDefinition = {
  id: 'aws_resources',
  provider: 'aws',
  display_name: 'AWS public-facing resources',
  description:
    'Enumerates the public attack surface of a connected AWS account ' +
    '— internet-facing ALB/NLBs, API Gateway REST/HTTP/WebSocket APIs, ' +
    'and Lambda Function URLs. Proposes each as a web_application / ' +
    'api target with auto-suggested scan config.',
  integration_type: 'aws',
  produces: ['web_application', 'api'],
  default_frequency_minutes: 1440, // 24h
  async run(ctx: DiscovererContext): Promise<DiscovererResult> {
    const creds = ctx.integrationCreds as AwsCreds;
    const meta = ctx.integrationMetadata as { regions?: string[] };
    const regions = (meta.regions && meta.regions.length > 0
      ? meta.regions
      : [creds.region ?? 'us-east-1', ...DEFAULT_REGIONS]
    )
      .filter((r, i, arr) => arr.indexOf(r) === i) // dedupe
      .slice(0, 6); // cap

    const runtimeCreds = await resolveAwsCreds(creds, regions[0]);

    // Fan out across regions in parallel — each region's enumeration
    // is independent and a per-region 403/timeout shouldn't fail the
    // whole run. Aggregate errors into partial_error.
    const errors: string[] = [];
    const allAssets: DiscoveredAsset[] = [];

    await Promise.all(
      regions.map(async (region) => {
        try {
          const regional = await discoverRegion(region, runtimeCreds, ctx);
          allAssets.push(...regional.assets);
          if (regional.error) errors.push(`${region}: ${regional.error}`);
        } catch (e) {
          errors.push(
            `${region}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );

    return {
      assets: allAssets,
      partial_error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};

async function resolveAwsCreds(
  creds: AwsCreds,
  region: string,
): Promise<RuntimeAwsCreds> {
  if (creds.role_arn) {
    const sts = new STSClient({ region });
    const out = await sts.send(
      new AssumeRoleCommand({
        RoleArn: creds.role_arn,
        RoleSessionName: 'tensorshield-asset-discovery',
        DurationSeconds: 3600,
        ExternalId: creds.external_id,
      }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) {
      throw new Error('STS AssumeRole returned no credentials');
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    };
  }
  if (creds.access_key_id && creds.secret_access_key) {
    return {
      accessKeyId: creds.access_key_id,
      secretAccessKey: creds.secret_access_key,
    };
  }
  throw new Error(
    'aws integration vault has neither role_arn nor (access_key_id + secret_access_key)',
  );
}

interface RegionalResult {
  assets: DiscoveredAsset[];
  error?: string;
}

async function discoverRegion(
  region: string,
  runtimeCreds: RuntimeAwsCreds,
  ctx: DiscovererContext,
): Promise<RegionalResult> {
  const assets: DiscoveredAsset[] = [];
  const subErrors: string[] = [];

  // --- 1. ALBs / NLBs ---------------------------------------------
  try {
    const elb = new ElasticLoadBalancingV2Client({
      region,
      credentials: runtimeCreds,
    });
    const out = await elb.send(new DescribeLoadBalancersCommand({}));
    for (const lb of out.LoadBalancers ?? []) {
      // Internet-facing only — the auditor's surface map is about
      // what outsiders can reach. Internal LBs are CSPM concerns,
      // not DAST surface.
      if (lb.Scheme !== 'internet-facing') continue;
      if (!lb.DNSName || !lb.LoadBalancerArn) continue;
      assets.push({
        asset_type: 'web_application',
        canonical_id: `aws:${region}:lb/${lb.LoadBalancerArn.split('/').slice(-3).join('/')}`,
        display_name: `${lb.LoadBalancerName ?? lb.DNSName} (${region})`,
        attributes: {
          value: `https://${lb.DNSName}`,
          upstream_url: `https://console.aws.amazon.com/ec2/v2/home?region=${region}#LoadBalancer:loadBalancerArn=${encodeURIComponent(lb.LoadBalancerArn)}`,
          tags: [
            `region:${region}`,
            `lb_type:${lb.Type ?? 'unknown'}`,
            ...(lb.Type === 'application' ? ['layer:l7'] : ['layer:l4']),
          ],
          aws_arn: lb.LoadBalancerArn,
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
    subErrors.push(`elbv2: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 2. API Gateway REST APIs (v1) -------------------------------
  try {
    const apigw = new APIGatewayClient({ region, credentials: runtimeCreds });
    const out = await apigw.send(new GetRestApisCommand({ limit: 500 }));
    for (const api of out.items ?? []) {
      if (!api.id) continue;
      // REST APIs publish at https://<id>.execute-api.<region>.amazonaws.com/<stage>
      // We don't know the stage at this point — propose the base URL
      // and let the customer add the stage in scan config.
      const baseUrl = `https://${api.id}.execute-api.${region}.amazonaws.com`;
      assets.push({
        asset_type: 'api',
        canonical_id: `aws:${region}:apigw-rest/${api.id}`,
        display_name: `${api.name ?? api.id} (REST · ${region})`,
        attributes: {
          value: baseUrl,
          description: api.description ?? undefined,
          upstream_url: `https://console.aws.amazon.com/apigateway/main/apis?region=${region}`,
          tags: [`region:${region}`, 'apigw:rest', 'aws'],
          aws_api_id: api.id,
          region,
          integration_id: ctx.integrationId,
        },
        suggested_config: {
          scan_mode: 'standard',
          scan_frequency: 'weekly',
          integration_id: ctx.integrationId,
          // The customer will need to add the stage suffix (/prod, /v1)
          // before this becomes scannable. The UI surface this as a
          // soft warning.
          requires_stage: true,
        },
        confidence: 'medium',
      });
    }
  } catch (e) {
    subErrors.push(`apigw_v1: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 3. API Gateway v2 (HTTP / WebSocket) ------------------------
  try {
    const apigw2 = new ApiGatewayV2Client({ region, credentials: runtimeCreds });
    const out = await apigw2.send(new GetApisCommand({ MaxResults: '500' }));
    for (const api of out.Items ?? []) {
      if (!api.ApiId || !api.ApiEndpoint) continue;
      const isWebsocket = api.ProtocolType === 'WEBSOCKET';
      assets.push({
        asset_type: 'api',
        canonical_id: `aws:${region}:apigw-v2/${api.ApiId}`,
        display_name: `${api.Name ?? api.ApiId} (${api.ProtocolType ?? 'v2'} · ${region})`,
        attributes: {
          value: api.ApiEndpoint,
          description: api.Description ?? undefined,
          upstream_url: `https://console.aws.amazon.com/apigateway/main/apis?region=${region}&api=${api.ApiId}`,
          tags: [
            `region:${region}`,
            isWebsocket ? 'apigw:websocket' : 'apigw:http',
            'aws',
          ],
          aws_api_id: api.ApiId,
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
    subErrors.push(`apigw_v2: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 4. Lambda function URLs -------------------------------------
  // ListFunctions returns up to 50 functions per page; for the
  // discoverer we cap at the first 200 (i.e. 4 pages) per region to
  // bound the API budget. Per-function GetFunctionUrlConfig is one
  // call each — we only fire it for the function names we care about.
  try {
    const lambda = new LambdaClient({ region, credentials: runtimeCreds });
    const fnNames: string[] = [];
    let marker: string | undefined;
    for (let i = 0; i < 4; i++) {
      const out = await lambda.send(
        new ListFunctionsCommand({ Marker: marker }),
      );
      for (const fn of out.Functions ?? []) {
        if (fn.FunctionName) fnNames.push(fn.FunctionName);
      }
      marker = out.NextMarker;
      if (!marker) break;
    }
    // Per-function URL config — best-effort, errors swallowed.
    const urlChecks = await Promise.all(
      fnNames.map(async (name) => {
        try {
          const r = await lambda.send(
            new GetFunctionUrlConfigCommand({ FunctionName: name }),
          );
          return { name, url: r.FunctionUrl, authType: r.AuthType };
        } catch {
          return { name, url: undefined, authType: undefined };
        }
      }),
    );
    for (const c of urlChecks) {
      if (!c.url) continue;
      // Only propose AWS_IAM=NONE function URLs as scan targets —
      // IAM-protected ones aren't externally reachable without an
      // AWS principal, which DAST can't simulate from the outside.
      if (c.authType !== 'NONE') continue;
      assets.push({
        asset_type: 'web_application',
        canonical_id: `aws:${region}:lambda-url/${c.name}`,
        display_name: `${c.name} (Lambda URL · ${region})`,
        attributes: {
          value: c.url,
          upstream_url: `https://console.aws.amazon.com/lambda/home?region=${region}#/functions/${c.name}`,
          tags: [`region:${region}`, 'lambda:url', 'auth:none'],
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
    subErrors.push(`lambda: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    assets,
    error: subErrors.length > 0 ? subErrors.join('; ') : undefined,
  };
}
