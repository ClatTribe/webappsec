// Continuous evidence collector runner.
//
// Bridges three layers:
//
//   1. The cron route (POST /api/cron/evidence-collectors) which fires
//      this for every due collector returned by `due_collectors()`.
//   2. The collector implementation (pure-ish; reads upstream API,
//      returns EvidenceRow[]).
//   3. The Supabase admin client which decrypts the integration vault
//      payload, calls `upsert_collector_evidence`, and writes
//      evidence_collector_runs audit rows.
//
// This isolation means a collector implementation has zero DB or
// auth code — it gets creds in and returns evidence out.

import { createAdminClient } from '@/lib/supabase/admin';
import { findCollector } from './registry';
import type { CollectorContext } from './types';

interface RunOutcome {
  status: 'success' | 'partial' | 'error' | 'skipped';
  evidence_count: number;
  produced_frameworks: string[];
  error_message: string | null;
}

interface IntegrationRow {
  id: string;
  org_id: string;
  type: string;
  status: string;
  metadata: Record<string, unknown> | null;
  vault_secret_id: string | null;
}

/** Run a single (org, collector) pair to completion. Always writes
 *  a row to evidence_collector_runs and bumps the parent
 *  evidence_collectors row's last_run_* columns. Never throws —
 *  errors are captured into the run row so the cron caller can
 *  count failures without aborting the batch. */
export async function runCollector(args: {
  collectorPkId: string;
  orgId: string;
  collectorId: string;
  integrationId: string | null;
}): Promise<RunOutcome> {
  const admin = createAdminClient();
  const started = new Date().toISOString();

  // ---- 1. Reserve a run row so we have an id to attach errors to ----
  const { data: runRow, error: runRowErr } = (await admin
    .from('evidence_collector_runs')
    .insert({
      org_id: args.orgId,
      collector_id: args.collectorId,
      status: 'running',
      started_at: started,
    } as never)
    .select('id')
    .single()) as unknown as { data: { id: string } | null; error: { message: string } | null };

  if (runRowErr || !runRow) {
    // Run-row insert is the audit trail; if we can't write it we
    // shouldn't proceed (no way to record the result).
    return {
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `failed to create run row: ${runRowErr?.message ?? 'unknown'}`,
    };
  }
  const runId = runRow.id;

  // Helper: persist outcome to both run-row and parent collector-row.
  const finalize = async (outcome: RunOutcome): Promise<RunOutcome> => {
    const nowIso = new Date().toISOString();
    await admin
      .from('evidence_collector_runs')
      .update({
        finished_at: nowIso,
        status: outcome.status,
        evidence_count: outcome.evidence_count,
        error_message: outcome.error_message,
        produced_frameworks: outcome.produced_frameworks,
      } as never)
      .eq('id', runId);
    await admin
      .from('evidence_collectors')
      .update({
        last_run_at: nowIso,
        last_run_status: outcome.status,
        last_run_error: outcome.error_message,
        last_run_evidence_count: outcome.evidence_count,
      } as never)
      .eq('id', args.collectorPkId);
    return outcome;
  };

  // ---- 2. Resolve the collector implementation -----------------
  const collector = findCollector(args.collectorId);
  if (!collector) {
    return finalize({
      status: 'skipped',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `unknown collector_id: ${args.collectorId}`,
    });
  }

  // ---- 3. Resolve the linked integration + decrypt creds -------
  if (!args.integrationId) {
    return finalize({
      status: 'skipped',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: 'collector has no linked integration_id',
    });
  }

  const { data: intRow } = (await admin
    .from('integrations')
    .select('id, org_id, type, status, metadata, vault_secret_id')
    .eq('id', args.integrationId)
    .maybeSingle()) as unknown as { data: IntegrationRow | null };

  if (!intRow) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `linked integration ${args.integrationId} not found`,
    });
  }
  if (intRow.org_id !== args.orgId) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: 'integration org_id does not match collector org_id',
    });
  }
  if (intRow.status !== 'active') {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `integration is not active (status: ${intRow.status})`,
    });
  }
  if (intRow.type !== collector.integration_type) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `integration type ${intRow.type} does not match collector's expected ${collector.integration_type}`,
    });
  }
  if (!intRow.vault_secret_id) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: 'integration has no vault_secret_id',
    });
  }

  // Decrypt via the vault decrypted_secrets view. Same pattern as
  // /api/integrations/[id]/repos/route.ts — no scan_id available,
  // so we go through vault directly (service-role only).
  const { data: vaultRow } = (await (
    admin as unknown as { schema: (s: string) => ReturnType<typeof admin.from> }
  )
    .schema('vault')
    .from('decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', intRow.vault_secret_id)
    .single()) as unknown as { data: { decrypted_secret: string } | null };

  if (!vaultRow?.decrypted_secret) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: 'failed to decrypt integration vault secret',
    });
  }

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(vaultRow.decrypted_secret);
  } catch {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: 'integration vault secret is not valid JSON',
    });
  }

  // ---- 4. Run the collector ------------------------------------
  const ctx: CollectorContext = {
    orgId: args.orgId,
    integrationId: intRow.id,
    integrationType: collector.integration_type,
    integrationCreds: creds,
    integrationMetadata: intRow.metadata ?? {},
  };

  let result;
  try {
    result = await collector.run(ctx);
  } catch (e) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: e instanceof Error ? e.message : String(e),
    });
  }

  // ---- 5. Upsert the batch ------------------------------------
  if (result.rows.length === 0) {
    return finalize({
      status: result.partial_error ? 'partial' : 'success',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: result.partial_error ?? null,
    });
  }

  const { error: upsertErr } = await admin.rpc('upsert_collector_evidence', {
    p_org_id: args.orgId,
    p_collector_id: args.collectorId,
    p_evidence: result.rows,
  } as never);

  if (upsertErr) {
    return finalize({
      status: 'error',
      evidence_count: 0,
      produced_frameworks: [],
      error_message: `upsert failed: ${upsertErr.message}`,
    });
  }

  const frameworks = [...new Set(result.rows.map((r) => r.framework))];
  return finalize({
    status: result.partial_error ? 'partial' : 'success',
    evidence_count: result.rows.length,
    produced_frameworks: frameworks,
    error_message: result.partial_error ?? null,
  });
}
