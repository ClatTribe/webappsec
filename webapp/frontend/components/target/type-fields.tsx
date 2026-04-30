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
