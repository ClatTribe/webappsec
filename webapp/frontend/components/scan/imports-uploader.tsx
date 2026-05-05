'use client';

import { useCallback, useId, useRef, useState } from 'react';
import {
  Upload,
  FileText,
  X,
  Loader2,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

// ImportsUploader — drag-drop HAR / Burp project upload (engine PR #141 /
// wishlist §15.2 row 1).
//
// Files are uploaded by the BROWSER directly to the `user-uploads` bucket
// using the user-context Supabase client. The "members upload user files"
// RLS policy gates `<org_id>/...` prefixes; the form accepts arbitrary
// `<org_id>/scan-imports/<random>/<filename>` keys and the server-side
// SQL re-checks the prefix as defence in depth.
//
// Engine support:
//   .har          → ingest_har_file(path)
//   .xml          → ingest_burp_file(path)   (Burp project XML)
//
// Limits (mirrored in the API route's zod schema):
//   - Max 5 files per scan
//   - Max 50 MiB per file
//   - Total enforced by the API; the uploader just blocks individual
//     too-large files at selection time so the operator gets fast feedback.
//
// Why client-side upload rather than server-side multipart parsing?
// Server-side multipart in Next.js API routes is awkward (no built-in
// formidable-style helper, edge-runtime restrictions); client-side keeps
// the file bytes off the wrapper's runtime entirely and the RLS policy
// already prevents cross-org abuse.

const MAX_FILES = 5;
const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPTED = '.har,.xml,application/json,application/xml,text/xml';

export interface ImportRef {
  kind: 'har' | 'burp';
  storage_path: string;
  filename: string;
  size_bytes: number;
}

interface UploadingFile {
  id: string;
  file: File;
  progress: 'uploading' | 'done' | 'error';
  error?: string;
  ref?: ImportRef;
}

interface Props {
  orgId: string;
  imports: ImportRef[];
  onChange: (imports: ImportRef[]) => void;
}

function inferKind(filename: string): 'har' | 'burp' | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.har')) return 'har';
  if (lower.endsWith('.xml')) return 'burp';
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export default function ImportsUploader({ orgId, imports, onChange }: Props) {
  const supabase = createClient();
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const totalCount = imports.length + uploads.filter((u) => u.progress === 'uploading').length;

  const handleFiles = useCallback(
    async (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const slotsLeft = Math.max(0, MAX_FILES - imports.length - uploads.length);
      const accepted = list.slice(0, slotsLeft);
      const newUploads: UploadingFile[] = [];

      for (const file of accepted) {
        const kind = inferKind(file.name);
        if (!kind) {
          newUploads.push({
            id: crypto.randomUUID(),
            file,
            progress: 'error',
            error: 'Unsupported file type — only .har or .xml accepted',
          });
          continue;
        }
        if (file.size > MAX_BYTES) {
          newUploads.push({
            id: crypto.randomUUID(),
            file,
            progress: 'error',
            error: `Too large (max ${formatBytes(MAX_BYTES)})`,
          });
          continue;
        }
        newUploads.push({
          id: crypto.randomUUID(),
          file,
          progress: 'uploading',
        });
      }

      setUploads((prev) => [...prev, ...newUploads]);

      // Fire each upload in parallel — small files, no need to serialise.
      // We track per-file state via uploads[i].id so a failure of one
      // doesn't block the others' progress feedback.
      await Promise.all(
        newUploads
          .filter((u) => u.progress === 'uploading')
          .map(async (u) => {
            const kind = inferKind(u.file.name)!;
            const random = crypto.randomUUID();
            const path = `${orgId}/scan-imports/${random}/${u.file.name}`;

            const { error } = await supabase.storage
              .from('user-uploads')
              .upload(path, u.file, {
                contentType: u.file.type || 'application/octet-stream',
                upsert: false,
              });

            if (error) {
              setUploads((prev) =>
                prev.map((x) => (x.id === u.id ? { ...x, progress: 'error', error: error.message } : x)),
              );
              return;
            }

            const ref: ImportRef = {
              kind,
              storage_path: path,
              filename: u.file.name,
              size_bytes: u.file.size,
            };
            setUploads((prev) =>
              prev.map((x) => (x.id === u.id ? { ...x, progress: 'done', ref } : x)),
            );
            onChange([...imports.filter((i) => i.storage_path !== ref.storage_path), ref]);
          }),
      );
    },
    [imports, onChange, orgId, supabase, uploads],
  );

  const removeImport = (path: string) => {
    onChange(imports.filter((i) => i.storage_path !== path));
    setUploads((prev) => prev.filter((u) => u.ref?.storage_path !== path));
    // Best-effort: try to remove the orphan file from storage. Failure
    // here is non-fatal — Supabase storage TTL/cron-cleanup handles
    // truly abandoned objects, and any real follow-up scan won't
    // reference a removed import path anyway.
    void supabase.storage.from('user-uploads').remove([path]);
  };

  const isFull = totalCount >= MAX_FILES;

  return (
    <section>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-300">
        Pre-load traffic <span className="text-neutral-500">(optional)</span>
      </div>
      <p className="mb-2 text-[11px] text-neutral-500">
        Drop a Burp project XML or HAR export and the engine will ingest it
        before exploring on its own. Most pen-tests start with a recording —
        this is the on-ramp.
      </p>

      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isFull) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (isFull) return;
          if (e.dataTransfer.files.length > 0) {
            void handleFiles(e.dataTransfer.files);
          }
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
          isFull
            ? 'cursor-not-allowed border-neutral-800 bg-neutral-900/20 opacity-50'
            : dragOver
              ? 'border-cyan-500/60 bg-cyan-500/[0.08]'
              : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700 hover:bg-neutral-900/50'
        }`}
      >
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          disabled={isFull}
          className="sr-only"
        />
        <Upload className="h-5 w-5 text-neutral-500" strokeWidth={2} />
        <span className="text-[12.5px] font-medium text-neutral-300">
          {isFull
            ? `Maximum ${MAX_FILES} imports reached`
            : 'Drop a .har or Burp .xml here, or click to browse'}
        </span>
        <span className="text-[10.5px] text-neutral-500">
          Up to {MAX_FILES} files · max {formatBytes(MAX_BYTES)} each
        </span>
      </label>

      {(imports.length > 0 || uploads.length > 0) && (
        <ul className="mt-2 space-y-1.5">
          {imports.map((ref) => (
            <li
              key={ref.storage_path}
              className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-3 py-1.5 text-[11.5px]"
            >
              <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-emerald-300" strokeWidth={2.25} />
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate font-mono text-neutral-200">
                {ref.filename}
              </span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                {ref.kind}
              </span>
              <span className="font-mono text-[10.5px] text-neutral-500">
                {formatBytes(ref.size_bytes)}
              </span>
              <button
                type="button"
                onClick={() => removeImport(ref.storage_path)}
                className="ml-1 rounded p-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                title="Remove this import"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </li>
          ))}
          {uploads
            .filter((u) => u.progress !== 'done')
            .map((u) => (
              <li
                key={u.id}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11.5px] ${
                  u.progress === 'error'
                    ? 'border-rose-500/30 bg-rose-500/[0.05]'
                    : 'border-neutral-800 bg-neutral-900/40'
                }`}
              >
                {u.progress === 'uploading' ? (
                  <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-cyan-300" strokeWidth={2.25} />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-rose-300" strokeWidth={2.25} />
                )}
                <FileText className="h-3.5 w-3.5 flex-shrink-0 text-neutral-500" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
                  {u.file.name}
                </span>
                {u.progress === 'error' ? (
                  <span className="text-[10.5px] text-rose-300">{u.error}</span>
                ) : (
                  <span className="font-mono text-[10.5px] text-neutral-500">
                    {formatBytes(u.file.size)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setUploads((prev) => prev.filter((x) => x.id !== u.id))
                  }
                  className="ml-1 rounded p-0.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </li>
            ))}
        </ul>
      )}

      {/* Privacy reminder. The engine redacts sensitive headers on
          ingest — wishlist §15.2 row 4 — so the operator can be sure
          tokens don't leak into scan artifacts. We mirror that copy
          here so the answer is visible at upload time. */}
      <p className="mt-2 rounded-md border border-neutral-800/60 bg-neutral-950/30 px-3 py-2 text-[10.5px] leading-relaxed text-neutral-500">
        The engine redacts sensitive header values (Authorization, Cookie,
        X-API-Key, X-CSRF-Token, etc.) at ingest. Header NAMES are kept;
        VALUES never enter scan artifacts.
      </p>
    </section>
  );
}
