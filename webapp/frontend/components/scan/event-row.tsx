'use client';

import { useState } from 'react';
import {
  Play,
  Terminal,
  CheckCircle2,
  AlertOctagon,
  Bot,
  Activity,
  Wrench,
  FileText,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScanEvent } from '@/lib/supabase/types';

const EVENT_META: Record<string, { label: string; Icon: LucideIcon; color: string }> = {
  'scan.started': { label: 'Scan started', Icon: Play, color: 'text-blue-300' },
  'scan.command': { label: 'Strix command', Icon: Terminal, color: 'text-blue-300' },
  'scan.finished': { label: 'Scan finished', Icon: CheckCircle2, color: 'text-emerald-300' },
  'finding.created': { label: 'Vulnerability found', Icon: AlertOctagon, color: 'text-red-300' },
  'agent.created': { label: 'Agent created', Icon: Bot, color: 'text-violet-300' },
  'agent.status.updated': { label: 'Agent status', Icon: Activity, color: 'text-violet-300' },
  'tool.execution.started': { label: 'Tool call', Icon: Wrench, color: 'text-amber-300' },
  'tool.execution.updated': { label: 'Tool result', Icon: Wrench, color: 'text-amber-300' },
  log: { label: 'Log', Icon: FileText, color: 'text-neutral-400' },
};

function summary(event: ScanEvent): string {
  const p = event.payload as Record<string, unknown> | null;
  if (!p) return '';
  if (event.event_type === 'log') return String(p.line ?? '').slice(0, 200);
  if (event.event_type === 'finding.created') {
    return `[${(p.severity ?? 'info').toString().toUpperCase()}] ${p.title ?? p.vuln_id ?? ''}`;
  }
  if (event.event_type === 'scan.finished') return `status=${p.status} exit=${p.exit_code}`;
  if (event.event_type === 'scan.command') {
    const cmd = Array.isArray(p.cmd) ? (p.cmd as string[]).join(' ') : '';
    return cmd.slice(0, 200);
  }
  if (typeof p.tool_name === 'string') return p.tool_name;
  if (typeof p.agent_id === 'string') return p.agent_id;
  return '';
}

export default function EventRow({ event }: { event: ScanEvent }) {
  const [open, setOpen] = useState(false);
  const meta = EVENT_META[event.event_type] ?? {
    label: event.event_type,
    Icon: FileText,
    color: 'text-neutral-400',
  };
  const Icon = meta.Icon;
  const sum = summary(event);
  const hasPayload = event.payload != null;

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => hasPayload && setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          hasPayload ? 'hover:bg-neutral-900/60' : 'cursor-default'
        }`}
      >
        <ChevronRight
          className={`h-3 w-3 flex-shrink-0 text-neutral-600 transition-transform ${
            !hasPayload ? 'invisible' : open ? 'rotate-90 text-neutral-300' : ''
          }`}
          strokeWidth={2.5}
        />
        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${meta.color}`} strokeWidth={2} />
        <span className="w-20 flex-shrink-0 font-mono text-[10.5px] text-neutral-500">
          {new Date(event.created_at).toLocaleTimeString()}
        </span>
        <span className="w-44 flex-shrink-0 text-xs font-medium text-neutral-200">
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-neutral-400">
          {sum}
        </span>
      </button>
      {open && hasPayload && (
        <div className="px-4 pb-3 pl-[100px]">
          <pre className="overflow-x-auto rounded-lg border border-neutral-800/80 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
