'use client';

import {
  Code2,
  Globe,
  Network,
  Folder,
  GitBranch,
  Compass,
  Gauge,
  Filter,
  Server,
  Layers,
  Shuffle,
  FileJson,
  Plug,
  Container,
  Cloud,
  ShieldAlert,
  Lock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TargetType } from '@/lib/target-config';
import TagInput from './tag-input';

// Per-type form field card. Each card has its own colour accent matching
// the type's icon, an explainer line below the title, and well-shaped
// inputs for the fields the §9.1 augmenter knows about.
//
// Adding a new field to a type means: (1) zod in lib/target-config.ts,
// (2) input here, (3) entry in buildConfigForType (form caller), (4) Python
// augmenter, (5) test pin. The drift-resistance is the point.

export interface AllFields {
  branch: string;
  subdirectory: string;
  crawlSeeds: string[];
  rateLimitQps: string;
  // engine PRs #267 + #271 — api target type. spec_url is forwarded to
  // strix as `--openapi <url>` when set; the engine otherwise probes 11
  // standard publishing paths automatically.
  specUrl: string;
  // engine PR #274 — container_image target. severity_floor is passed
  // to Trivy via instruction text; private_registry is a UI hint that
  // gates a warning banner when no registry-auth integration is wired.
  imageSeverityFloor: '' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  imagePrivateRegistry: boolean;
  // engine PRs #290 / #291 — cloud_account target. provider drives
  // engine specialist dispatch (boto3 path for `aws`, Prowler for
  // everything else). region / role_arn / external_id are forwarded
  // via the existing materialize_credentials → AWS_* env vars path,
  // so most of the heavy lifting is wrapper-side.
  cloudProvider: '' | 'aws' | 'gcp' | 'azure' | 'kubernetes';
  cloudRoleArn: string;
  cloudExternalId: string;
  cloudRegion: string;
  subdomainExcludes: string[];
  portSpec: string;
  protocols: '' | 'tcp' | 'udp' | 'both';
  pathExcludes: string[];
  languageHints: string[];
}

interface Props {
  type: TargetType;
  value: AllFields;
  onChange: (next: AllFields) => void;
}

const TYPE_META: Record<
  TargetType,
  { Icon: LucideIcon; ring: string; tag: string; label: string }
> = {
  repository: {
    Icon: Code2,
    ring: 'border-violet-500/30',
    tag: 'bg-violet-500/15 text-violet-200 ring-violet-500/30',
    label: 'Repository configuration',
  },
  web_application: {
    Icon: Globe,
    ring: 'border-cyan-500/30',
    tag: 'bg-cyan-500/15 text-cyan-200 ring-cyan-500/30',
    label: 'Web application configuration',
  },
  api: {
    Icon: Plug,
    ring: 'border-indigo-500/30',
    tag: 'bg-indigo-500/15 text-indigo-200 ring-indigo-500/30',
    label: 'API target configuration',
  },
  container_image: {
    Icon: Container,
    ring: 'border-sky-500/30',
    tag: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
    label: 'Container image configuration',
  },
  cloud_account: {
    Icon: Cloud,
    ring: 'border-orange-500/30',
    tag: 'bg-orange-500/15 text-orange-200 ring-orange-500/30',
    label: 'Cloud account configuration',
  },
  domain: {
    Icon: Compass,
    ring: 'border-emerald-500/30',
    tag: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    label: 'Domain configuration',
  },
  ip_address: {
    Icon: Network,
    ring: 'border-amber-500/30',
    tag: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
    label: 'IP / network configuration',
  },
  local_code: {
    Icon: Folder,
    ring: 'border-sky-500/30',
    tag: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
    label: 'Local code configuration',
  },
};

export default function TypeFields({ type, value, onChange }: Props) {
  const meta = TYPE_META[type];
  const Icon = meta.Icon;

  const set = <K extends keyof AllFields>(key: K, v: AllFields[K]): void => {
    onChange({ ...value, [key]: v });
  };

  return (
    <section
      className={`rounded-2xl border ${meta.ring} bg-neutral-900/30 p-5`}
    >
      <header className="mb-4 flex items-center gap-2.5">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 ${meta.tag}`}>
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <h2 className="text-sm font-semibold text-neutral-100">{meta.label}</h2>
        <span className="ml-auto text-[11px] text-neutral-500">
          All optional — leave blank for sensible defaults
        </span>
      </header>

      {type === 'repository' && (
        <RepositoryFields value={value} set={set} />
      )}
      {type === 'web_application' && (
        <WebApplicationFields value={value} set={set} accent="cyan" />
      )}
      {type === 'api' && (
        <ApiFields value={value} set={set} />
      )}
      {type === 'container_image' && (
        <ContainerImageFields value={value} set={set} />
      )}
      {type === 'cloud_account' && (
        <CloudAccountFields value={value} set={set} />
      )}
      {type === 'domain' && (
        <DomainFields value={value} set={set} accent="emerald" />
      )}
      {type === 'ip_address' && (
        <IpAddressFields value={value} set={set} />
      )}
      {type === 'local_code' && (
        <LocalCodeFields value={value} set={set} accent="sky" />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

type Setter = <K extends keyof AllFields>(key: K, v: AllFields[K]) => void;

function FieldRow({
  Icon,
  label,
  hint,
  children,
}: {
  Icon: LucideIcon;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        <Icon className="h-3 w-3 text-neutral-500" strokeWidth={2.25} />
        {label}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-neutral-500">{hint}</div>}
    </div>
  );
}

function TextInput({
  placeholder,
  value,
  onChange,
  type = 'text',
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number';
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 font-mono text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
    />
  );
}

// --- Repository ------------------------------------------------------------

function RepositoryFields({ value, set }: { value: AllFields; set: Setter }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FieldRow Icon={GitBranch} label="Branch" hint="e.g. develop. Leave blank for the repo's default.">
        <TextInput placeholder="develop" value={value.branch} onChange={(v) => set('branch', v)} />
      </FieldRow>
      <FieldRow Icon={Layers} label="Subdirectory" hint="Monorepo? Scope to a single app, e.g. apps/api.">
        <TextInput placeholder="apps/api" value={value.subdirectory} onChange={(v) => set('subdirectory', v)} />
      </FieldRow>
    </div>
  );
}

// --- Web application -------------------------------------------------------

function WebApplicationFields({ value, set, accent }: { value: AllFields; set: Setter; accent: 'cyan' }) {
  return (
    <div className="space-y-4">
      <FieldRow
        Icon={Compass}
        label="Crawl seeds"
        hint="URLs the agent should start from. Without these, it crawls from the root."
      >
        <TagInput
          value={value.crawlSeeds}
          onChange={(v) => set('crawlSeeds', v)}
          placeholder="/login, /api, /admin"
          accent={accent}
          validate={(s) => (s.length > 500 ? 'too long' : null)}
        />
      </FieldRow>
      <FieldRow
        Icon={Gauge}
        label="Rate limit (req/s)"
        hint="Production traffic? Stay low (5–10). Internal staging? You can go higher."
      >
        <TextInput
          type="number"
          placeholder="10"
          value={value.rateLimitQps}
          onChange={(v) => set('rateLimitQps', v)}
        />
      </FieldRow>
    </div>
  );
}

// --- API -------------------------------------------------------------------

function ApiFields({ value, set }: { value: AllFields; set: Setter }) {
  return (
    <div className="space-y-4">
      <FieldRow
        Icon={FileJson}
        label="OpenAPI / Swagger spec URL"
        hint="Optional. Strix probes 11 standard paths automatically (/openapi.json, /swagger.json, /v3/api-docs, …). Set this if your spec lives elsewhere — forwarded as `--openapi <url>`."
      >
        <TextInput
          placeholder="https://api.myapp.com/openapi.json"
          value={value.specUrl}
          onChange={(v) => set('specUrl', v)}
        />
      </FieldRow>
      <FieldRow
        Icon={Gauge}
        label="Rate limit (req/s)"
        hint="Same caveat as web apps — stay low for production traffic. Burst probes (rate-limit specialist, BOLA, mass-assignment) honour this cap."
      >
        <TextInput
          type="number"
          placeholder="10"
          value={value.rateLimitQps}
          onChange={(v) => set('rateLimitQps', v)}
        />
      </FieldRow>
      <p className="rounded-md border border-indigo-500/20 bg-indigo-500/5 px-3 py-2 text-[11px] leading-relaxed text-indigo-200/80">
        <span className="font-medium text-indigo-100">Routed to the API tool catalog.</span> The
        agent runs OWASP API Top 10 specialists (BOLA, BFLA, mass-assignment, rate-limit) plus
        GraphQL deep introspection and gRPC reflection probes. Browser, DOM, and reflected-XSS
        tools are <span className="text-neutral-300">skipped</span> — they don&apos;t apply to
        JSON / gRPC surfaces.
      </p>
    </div>
  );
}

// --- Container image -------------------------------------------------------

function ContainerImageFields({ value, set }: { value: AllFields; set: Setter }) {
  return (
    <div className="space-y-4">
      <FieldRow
        Icon={ShieldAlert}
        label="Minimum severity"
        hint="Trivy filters out CVEs below this. Most production setups want HIGH+ to keep the inbox actionable; pick LOW for full visibility."
      >
        <select
          value={value.imageSeverityFloor}
          onChange={(e) => set('imageSeverityFloor', e.target.value as AllFields['imageSeverityFloor'])}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        >
          <option value="">Default (HIGH+)</option>
          <option value="LOW">LOW and above (everything)</option>
          <option value="MEDIUM">MEDIUM and above</option>
          <option value="HIGH">HIGH and above</option>
          <option value="CRITICAL">CRITICAL only</option>
        </select>
      </FieldRow>
      <FieldRow
        Icon={Lock}
        label="Private registry"
        hint="Tick if this image lives in a private registry. v1 expects registry auth in the worker's docker config; per-org registry credentials are on the roadmap."
      >
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-neutral-300">
          <input
            type="checkbox"
            checked={value.imagePrivateRegistry}
            onChange={(e) => set('imagePrivateRegistry', e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-neutral-700 bg-neutral-900 text-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
          />
          This image requires authentication to pull
        </label>
      </FieldRow>
      <p className="rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-[11px] leading-relaxed text-sky-200/80">
        <span className="font-medium text-sky-100">Routed to the container-image tool catalog.</span>{' '}
        The engine runs <code>scan_container_image</code> (Trivy) for OS + language-package CVEs,
        emits an SBOM, and decorates findings with KEV / EPSS data. New CVEs against your image
        packages auto-fire MOAK exploit synthesis. Browser, DOM, and DAST tools are{' '}
        <span className="text-neutral-300">skipped</span> — a registry artefact has no live surface.
      </p>
    </div>
  );
}

// --- Cloud account ---------------------------------------------------------
//
// CSPM target (engine PRs #290 / #291). The `value` field on the parent
// targets row carries `<provider>/<account_id>` so the engine's typed-
// prefix dispatch picks the right specialist. The fields below let the
// operator optionally override AWS-side auth at scan time (cross-account
// role assume) without re-creating the linked integration.

function CloudAccountFields({ value, set }: { value: AllFields; set: Setter }) {
  return (
    <div className="space-y-4">
      {/* Wishlist §17.3 — read-only contract notice. Pinned at the top
          of the panel so security teams reviewing credential grants
          see it before they get to the role-ARN field. The note
          mirrors engine PR #290's safety contract: ZERO mutating API
          calls; recommended grant is AWS-managed SecurityAudit. */}
      <div className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-200">
          <Lock className="h-3 w-3" strokeWidth={2.5} />
          Read-only contract
        </div>
        <p className="text-[11.5px] leading-relaxed text-emerald-100/85">
          The CSPM scanner makes <strong>zero mutating API calls</strong> — only{' '}
          <code className="rounded bg-emerald-500/15 px-1 font-mono text-[10.5px]">Describe*</code>,{' '}
          <code className="rounded bg-emerald-500/15 px-1 font-mono text-[10.5px]">Get*</code>,{' '}
          <code className="rounded bg-emerald-500/15 px-1 font-mono text-[10.5px]">List*</code>. We
          recommend the AWS-managed{' '}
          <code className="rounded bg-emerald-500/15 px-1 font-mono text-[10.5px]">SecurityAudit</code>{' '}
          managed policy on the role you grant. The scan attests live state — no resources are
          created, modified, or deleted.
        </p>
      </div>

      {/* Wishlist §17.3 — scheduled-scan callout. Cloud accounts don't
          change minute-to-minute; daily is the right cadence and the
          engine is idempotent. The scheduling control lives at the
          parent <ScheduleFields> level (scan_frequency); we just
          point at it from here so users understand cloud_account is
          the canonical schedule-it target. */}
      <div className="rounded-md border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-[11px] leading-relaxed text-cyan-100/85">
        <strong className="text-cyan-100">Schedule daily.</strong> CSPM is the canonical
        nightly-scan target — drift accumulates slowly and a daily attestation produces a clean
        24-hour history for auditors. Set{' '}
        <code className="rounded bg-cyan-500/15 px-1 font-mono text-[10.5px]">scan_frequency</code>{' '}
        to <code className="rounded bg-cyan-500/15 px-1 font-mono text-[10.5px]">daily</code> on
        this target after creation.
      </div>

      <FieldRow
        Icon={Cloud}
        label="Provider"
        hint="Which cloud the engine's CSPM specialist will scan. v1 ships first-class AWS (boto3, 14 CIS checks). Others go via the Prowler engine (PR #291) when the worker image has Prowler installed."
      >
        <select
          value={value.cloudProvider}
          onChange={(e) => set('cloudProvider', e.target.value as AllFields['cloudProvider'])}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        >
          <option value="">Select a provider…</option>
          <option value="aws">AWS (boto3 — recommended)</option>
          <option value="gcp">GCP (via Prowler)</option>
          <option value="azure">Azure (via Prowler)</option>
          <option value="kubernetes">Kubernetes (via Prowler)</option>
        </select>
      </FieldRow>
      <FieldRow
        Icon={GitBranch}
        label="Cross-account role ARN"
        hint="When set, the engine assumes this role via STS at scan time. Useful when the linked integration's base credentials live in a security-tooling account but the target is in a different account."
      >
        <input
          type="text"
          placeholder="arn:aws:iam::123456789012:role/strix-readonly"
          value={value.cloudRoleArn}
          onChange={(e) => set('cloudRoleArn', e.target.value)}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 font-mono text-xs transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
      </FieldRow>
      <FieldRow
        Icon={Lock}
        label="External ID"
        hint="Second factor for the role's trust policy. Forwarded to STS AssumeRole only when role_arn is set."
      >
        <input
          type="text"
          placeholder="optional"
          value={value.cloudExternalId}
          onChange={(e) => set('cloudExternalId', e.target.value)}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
      </FieldRow>
      <FieldRow
        Icon={Compass}
        label="Region override"
        hint="Overrides the region stored on the integration. Most CSPM checks scan all regions regardless; this only matters for region-pinned services."
      >
        <input
          type="text"
          placeholder="us-east-1"
          value={value.cloudRegion}
          onChange={(e) => set('cloudRegion', e.target.value)}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        />
      </FieldRow>
      <p className="rounded-md border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-[11px] leading-relaxed text-orange-200/80">
        <span className="font-medium text-orange-100">Routed to the CSPM tool catalog.</span> The
        engine runs <code>scan_cloud_account</code> (PR #291 / Prowler) when available, falling
        back to the boto3 path (<code>scan_aws_account_tool</code>, PR #290) for AWS. Findings are
        decorated with CIS AWS / Azure / GCP / Kubernetes mappings (PR #289). Pair this target
        with a repository target containing Terraform / Helm / K8s YAML to unlock IaC ↔ drift
        correlation (PR #292).
      </p>
    </div>
  );
}

// --- Domain ----------------------------------------------------------------

function DomainFields({ value, set, accent }: { value: AllFields; set: Setter; accent: 'emerald' }) {
  return (
    <FieldRow
      Icon={Filter}
      label="Subdomain excludes"
      hint="Glob patterns. Skip discovered subdomains that match any of these."
    >
      <TagInput
        value={value.subdomainExcludes}
        onChange={(v) => set('subdomainExcludes', v)}
        placeholder="*-staging, internal-*"
        accent={accent}
      />
    </FieldRow>
  );
}

// --- IP address ------------------------------------------------------------

function IpAddressFields({ value, set }: { value: AllFields; set: Setter }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FieldRow
        Icon={Server}
        label="Port spec"
        hint="nmap-style. e.g. 80,443,1-1024,8000-8090. Default: top-1000 TCP."
      >
        <TextInput
          placeholder="80,443,8000-8090"
          value={value.portSpec}
          onChange={(v) => set('portSpec', v)}
        />
      </FieldRow>
      <FieldRow Icon={Shuffle} label="Protocol">
        <select
          value={value.protocols}
          onChange={(e) => set('protocols', e.target.value as AllFields['protocols'])}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3.5 py-2.5 text-sm transition-colors focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
        >
          <option value="">Default (TCP, top-1000)</option>
          <option value="tcp">TCP only</option>
          <option value="udp">UDP only</option>
          <option value="both">TCP + UDP</option>
        </select>
      </FieldRow>
    </div>
  );
}

// --- Local code ------------------------------------------------------------

function LocalCodeFields({ value, set, accent }: { value: AllFields; set: Setter; accent: 'sky' }) {
  return (
    <div className="space-y-4">
      <FieldRow
        Icon={Filter}
        label="Path excludes"
        hint="Directories to skip. Common: node_modules, vendor, dist, __pycache__."
      >
        <TagInput
          value={value.pathExcludes}
          onChange={(v) => set('pathExcludes', v)}
          placeholder="node_modules, vendor, dist"
          accent={accent}
        />
      </FieldRow>
      <FieldRow
        Icon={Code2}
        label="Language hints"
        hint="Helps the agent prime its static-analysis tools."
      >
        <TagInput
          value={value.languageHints}
          onChange={(v) => set('languageHints', v)}
          placeholder="python, typescript, go"
          accent={accent}
        />
      </FieldRow>
    </div>
  );
}
