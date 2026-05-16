"""Thin wrapper around the Supabase Python client for the worker.

All worker operations go through service-role; we centralize that here so we never
accidentally use the anon key.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from supabase import Client, create_client

from .config import WorkerConfig


def _epoch_to_iso(t: float) -> str:
    """Convert a unix epoch float (engine convention) to an ISO 8601
    UTC string Supabase / PostgREST accepts for timestamptz columns.
    """
    return datetime.fromtimestamp(float(t), tz=timezone.utc).isoformat()


class WorkerSupabase:
    def __init__(self, cfg: WorkerConfig) -> None:
        self.client: Client = create_client(cfg.supabase_url, cfg.supabase_service_role_key)

    # --- Scans -----------------------------------------------------------

    def fetch_scan(self, scan_id: str) -> dict[str, Any]:
        """Fetch a scan with its targets, integrations, and parent target config.

        The parent target join brings in `targets.config` (the typed
        per-target-type configuration) so the worker's instruction
        augmenter can read it without a second round-trip.
        """
        result = (
            self.client.table("scans")
            .select(
                "*, "
                "scan_targets(*), "
                "scan_integrations(integration_id, integrations(id, type, name, vault_secret_id, metadata)), "
                "targets(id, type, value, config, auto_discover)"
            )
            .eq("id", scan_id)
            .single()
            .execute()
        )
        return result.data

    def start_scan(self, scan_id: str) -> None:
        """Legacy non-atomic start. Prefer claim_scan."""
        self.client.rpc("worker_start_scan", {"p_scan_id": scan_id}).execute()

    def claim_scan(self, scan_id: str) -> dict[str, Any] | None:
        """Atomically flip queued -> running. Returns the row only on win."""
        result = self.client.rpc("worker_claim_scan", {"p_scan_id": scan_id}).execute()
        # The RPC returns the scan row (jsonb representation of the table type)
        # or null when it didn't claim. Supabase python client wraps it.
        data = result.data
        if data is None:
            return None
        # Some Supabase client versions wrap a single-row result in a dict;
        # others return it raw. Normalise both.
        if isinstance(data, list):
            return data[0] if data else None
        return data if isinstance(data, dict) and data.get("id") else None

    def heartbeat_scan(self, scan_id: str) -> None:
        self.client.rpc("worker_heartbeat_scan", {"p_scan_id": scan_id}).execute()

    def mark_stale_scans(self, max_silence_seconds: int = 600) -> list[str]:
        """Sweep running scans whose heartbeat hasn't ticked in N seconds.

        Returns the scan_ids that were flipped to 'failed'.
        """
        result = self.client.rpc(
            "mark_stale_scans", {"p_max_silence_seconds": max_silence_seconds}
        ).execute()
        rows = result.data or []
        return [r["scan_id"] for r in rows if isinstance(r, dict) and r.get("scan_id")]

    def set_sbom_uploaded(self, scan_id: str) -> None:
        """Flag this scan as having a CycloneDX SBOM in storage
        (migration 032 / engine PR #131). UI keys the SBOM CTAs off
        this column so older scans (engines without #131) don't
        dangle broken view/download links."""
        self.client.rpc(
            "worker_set_sbom_uploaded", {"p_scan_id": scan_id}
        ).execute()

    def set_coverage(self, scan_id: str, coverage: dict[str, Any]) -> None:
        """Persist the engine's coverage.json verbatim (migration 039).

        The blob carries the engine's required-checks list + which
        ones actually ran; UI renders an amber "coverage incomplete"
        banner when `status="incomplete"`. Critical for the trust
        gap — a 0-finding scan is ambiguous between "site is clean"
        and "agent gave up early"; coverage tells you which.
        """
        self.client.rpc(
            "worker_set_coverage",
            {"p_scan_id": scan_id, "p_coverage": coverage},
        ).execute()

    def set_run_meta(self, scan_id: str, run_meta: dict[str, Any]) -> None:
        """Persist the engine's run_meta.json verbatim (migration 031).

        The blob carries vendor_risk, mfa_attestation, compliance_posture,
        and other structured engine signals the scan-page hero renders.
        Worker calls once per scan; UI reads typed paths into the JSONB.
        """
        self.client.rpc(
            "worker_set_run_meta",
            {"p_scan_id": scan_id, "p_run_meta": run_meta},
        ).execute()

    def set_compliance_pack_uploaded(self, scan_id: str) -> None:
        """Flag this scan's compliance pack as uploaded (migration 030).

        Called once at least one file from the engine's `--compliance-pack`
        bundle has landed in storage. The UI keys the "Download" button
        off this column so an empty pack dir (older engines, scans that
        ran before #129) doesn't dangle a broken download link.
        """
        self.client.rpc(
            "worker_set_compliance_pack_uploaded", {"p_scan_id": scan_id}
        ).execute()

    def insert_kg_nodes(self, rows: list[dict[str, Any]]) -> int:
        """Bulk-insert engine-emitted KG nodes (migration 058).

        Service-role bypasses RLS. Rows shape:
          {org_id, scan_id, node_id, node_type, props}

        Chunks to ~500 rows per request to stay under PostgREST's
        default payload cap. Returns the number of rows actually
        inserted (sum across chunks).
        """
        if not rows:
            return 0
        total = 0
        chunk = 500
        for i in range(0, len(rows), chunk):
            batch = rows[i : i + chunk]
            res = (
                self.client.table("kg_nodes")
                .insert(batch)
                .execute()
            )
            total += len(res.data or [])
        return total

    def insert_kg_edges(self, rows: list[dict[str, Any]]) -> int:
        """Bulk-insert engine-emitted KG edges (migration 058).

        Same chunking strategy as insert_kg_nodes. Rows shape:
          {org_id, scan_id, edge_id, edge_type,
           source_node_id, target_node_id, props}
        """
        if not rows:
            return 0
        total = 0
        chunk = 500
        for i in range(0, len(rows), chunk):
            batch = rows[i : i + chunk]
            res = (
                self.client.table("kg_edges")
                .insert(batch)
                .execute()
            )
            total += len(res.data or [])
        return total

    def attach_patches_to_findings(
        self,
        scan_id: str,
        by_finding: dict[str, dict[str, Any]],
    ) -> int:
        """Update findings rows with Patcher proposals (migration 058).

        `by_finding` is keyed by the engine's finding_id (matches
        `findings.vuln_id` set at insert time by worker_insert_finding).
        One UPDATE per finding; service-role bypasses RLS.

        We use scan_id + vuln_id as the WHERE — engine finding ids are
        only stable within a run, and re-running the scan reassigns
        them. A multi-target scan can have the same vuln_id across
        different targets, so we ALSO filter by scan_id (eliminates
        the cross-target collision).

        Returns the count of rows actually updated (skips proposals
        whose finding_id doesn't match any row in our DB — typically
        because the finding wasn't structured-emitted, only logged).
        """
        if not by_finding:
            return 0
        total_updated = 0
        for vuln_id, proposal in by_finding.items():
            update = {
                "patch_id": proposal.get("patch_id"),
                "patch_diff": proposal.get("diff"),
                "patch_commit_message": proposal.get("commit_message"),
                "patch_status": proposal.get("status") or "proposed",
            }
            verified_at = proposal.get("verified_at")
            if isinstance(verified_at, (int, float)) and verified_at > 0:
                update["patch_verified_at"] = _epoch_to_iso(verified_at)
            created_at = proposal.get("created_at")
            if isinstance(created_at, (int, float)) and created_at > 0:
                update["patch_proposed_at"] = _epoch_to_iso(created_at)
            try:
                res = (
                    self.client.table("findings")
                    .update(update)
                    .eq("scan_id", scan_id)
                    .eq("vuln_id", vuln_id)
                    .execute()
                )
                total_updated += len(res.data or [])
            except Exception:  # noqa: BLE001
                # Don't let one malformed proposal kill the whole batch.
                # `_ingest_patches_from_run_dir` will log the failure
                # context; we just keep going.
                continue
        return total_updated

    def ingest_compliance_evidence(
        self,
        scan_id: str,
        evidence: dict,
    ) -> int:
        """Ingest engine compliance_evidence.json into the wrapper's
        structured per-control table (migration 046).

        `evidence` is the parsed JSON payload from
        `<compliance_pack>/<run_id>/compliance_evidence.json` — a
        framework→control_id→{verdict,summary,detail} map.

        Returns the count of controls actually persisted. Skips controls
        whose verdict isn't in the CHECK set (pass/fail/warn/info/untested)
        rather than failing the whole ingest.

        Best-effort caller pattern: log + continue on failure. A failed
        ingest means the chat handler will answer "no evidence yet" until
        the next scan succeeds, which is correct.
        """
        result = self.client.rpc(
            "worker_ingest_compliance_evidence",
            {"p_scan_id": scan_id, "p_evidence": evidence},
        ).execute()
        return int(result.data or 0)

    def set_preflight_failed(self, scan_id: str) -> None:
        """Flag this scan as preflight-failed (migration 029).

        Called after pattern-matching engine PR #30 preflight markers
        in stderr. UI renders an amber "preflight failed" banner using
        this column. Best-effort: any failure is logged and the scan
        finishes without the flag — the failure surfaces via exit_code
        and error_message regardless.
        """
        self.client.rpc(
            "worker_set_preflight_failed", {"p_scan_id": scan_id}
        ).execute()

    def finish_scan(
        self,
        scan_id: str,
        status: str,
        *,
        exit_code: int | None = None,
        error_message: str | None = None,
        total_input_tokens: int = 0,
        total_output_tokens: int = 0,
        total_cost: float = 0.0,
        agents_count: int = 0,
    ) -> None:
        self.client.rpc(
            "worker_finish_scan",
            {
                "p_scan_id": scan_id,
                "p_status": status,
                "p_exit_code": exit_code,
                "p_error_message": error_message,
                "p_total_input_tokens": total_input_tokens,
                "p_total_output_tokens": total_output_tokens,
                "p_total_cost": total_cost,
                "p_agents_count": agents_count,
            },
        ).execute()

    # --- Events ----------------------------------------------------------

    def emit_event(self, scan_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.client.rpc(
            "worker_insert_scan_event",
            {"p_scan_id": scan_id, "p_event_type": event_type, "p_payload": payload},
        ).execute()

    # --- Findings --------------------------------------------------------

    def insert_finding(
        self, scan_id: str, vuln_id: str, title: str, severity: str, payload: dict[str, Any]
    ) -> str:
        result = self.client.rpc(
            "worker_insert_finding",
            {
                "p_scan_id": scan_id,
                "p_vuln_id": vuln_id,
                "p_title": title,
                "p_severity": severity,
                "p_payload": payload,
            },
        ).execute()
        return result.data

    # --- Integration credentials ----------------------------------------

    def decrypt_integration(self, scan_id: str, integration_id: str) -> str:
        """Returns the plaintext secret blob (typically JSON)."""
        result = self.client.rpc(
            "worker_decrypt_integration",
            {"p_scan_id": scan_id, "p_integration_id": integration_id},
        ).execute()
        return result.data

    def decrypt_scan_auth(self, scan_id: str) -> tuple[str | None, str | None]:
        """Resolve the auth credentials for a scan (Phase A / migration 061).

        Returns (auth_method, plaintext). Both are None when neither the
        scan nor the parent target has an `auth_method` configured. The
        method comes from the scan override first, falling back to the
        target's default — same precedence as the engine accepts on the
        CLI when both are passed.

        Auth-method strings + corresponding plaintext shapes (engine
        contract — matches strix/interface/main.py):
          bearer       → "<token>"
          cookie       → "k=v; k2=v2"
          basic        → "user:pass"
          login_creds  → "email:user@x.com:pass:hunter2"
          header       → JSON: {"headers": ["X-A: 1", "X-B: 2"]}
          none         → method only, no plaintext

        Best-effort: any RPC failure returns (None, None) and the
        worker falls through to "no auth" — the scan still runs, just
        against the unauthenticated surface.
        """
        try:
            result = self.client.rpc(
                "worker_decrypt_scan_auth", {"p_scan_id": scan_id}
            ).execute()
        except Exception:  # noqa: BLE001
            return (None, None)
        rows = result.data or []
        if not rows:
            return (None, None)
        row = rows[0] if isinstance(rows, list) else rows
        return (row.get("auth_method"), row.get("plaintext"))

    def decrypt_org_slack_webhook(self, scan_id: str) -> str | None:
        """Returns the org's Slack webhook URL, or None when none is set
        / the stored secret doesn't match the expected hooks.slack.com
        prefix (defence-in-depth — the SQL RPC re-validates).

        Wraps `worker_decrypt_org_slack_webhook(p_scan_id)` from
        migration 037. Best-effort: any RPC error returns None so the
        notifier silently no-ops rather than failing scan finalisation.
        """
        try:
            result = self.client.rpc(
                "worker_decrypt_org_slack_webhook", {"p_scan_id": scan_id}
            ).execute()
            return result.data
        except Exception:  # noqa: BLE001
            return None

    def enqueue_scheduled_scans(self) -> int:
        """Trigger the periodic scheduled-scan sweep (migration 050).

        Calls worker_enqueue_scheduled_scans() which finds targets whose
        cadence is up and inserts queued scan rows for each. The existing
        scan_queued pg_notify trigger pings the worker fleet to pick them
        up via the normal dispatch path.

        Returns the count of scans enqueued in this sweep. Failures are
        propagated — the worker's loop traps them so the daemon keeps
        running.
        """
        result = self.client.rpc("worker_enqueue_scheduled_scans").execute()
        return int(result.data or 0)

    def decrypt_org_slack_webhook_by_org(self, org_id: str) -> str | None:
        """Returns the org's Slack webhook URL when called outside a scan
        context (e.g. the chat-bridge worker forwarding agent_messages).

        Mirrors decrypt_org_slack_webhook but the SQL RPC keys on org_id
        directly. See migration 049. Same fail-open behaviour: any RPC
        error returns None so the bridge silently skips rather than
        propagating an exception into the listener loop.
        """
        try:
            result = self.client.rpc(
                "worker_decrypt_org_slack_webhook_by_org", {"p_org_id": org_id}
            ).execute()
            return result.data
        except Exception:  # noqa: BLE001
            return None

    def decrypt_org_llm_key(self, scan_id: str) -> str | None:
        try:
            result = self.client.rpc(
                "worker_decrypt_org_llm_key", {"p_scan_id": scan_id}
            ).execute()
            return result.data
        except Exception:  # noqa: BLE001
            # No per-org key configured — fall back to default.
            return None

    def decrypt_org_secrets(self, scan_id: str) -> dict[str, str]:
        """Decrypt this org's STRIX_* recon API keys (migration 028).

        Returns a dict like {"STRIX_GITHUB_TOKEN": "...", ...} — empty
        when no keys are configured, partial when some decrypts failed
        (the RPC's defensive `begin … exception … end` per-row handler).
        Caller forwards each pair to the sandbox env.

        Per-key failures land in audit_log; the worker proceeds with
        whatever decrypted successfully — partial coverage is better
        than failing the whole scan because one secret was rotated.
        """
        try:
            result = self.client.rpc(
                "worker_decrypt_org_secrets", {"p_scan_id": scan_id}
            ).execute()
            data = result.data
            if isinstance(data, dict):
                # Filter to only non-empty string values; defensive against
                # any RPC-side type drift.
                return {k: v for k, v in data.items() if isinstance(v, str) and v}
            return {}
        except Exception:  # noqa: BLE001
            # No keys configured / vault unreachable — engine fails open
            # silently per-tool. Don't take the scan down with us.
            return {}

    # --- Storage ---------------------------------------------------------

    def upload_artifact(
        self, bucket: str, path: str, contents: bytes, content_type: str = "text/plain"
    ) -> None:
        self.client.storage.from_(bucket).upload(
            path, contents, {"content-type": content_type, "upsert": "true"}
        )

    def download_artifact(self, bucket: str, path: str) -> bytes:
        """Read a file from storage as bytes.

        Used by `_download_imports` to pull HAR / Burp files the user
        uploaded to `user-uploads/<org>/scan-imports/...` (engine PR #141 /
        migration 035). Service-role client bypasses RLS — the SQL RPC
        already re-validated the storage_path's org prefix before the
        worker ever sees it, so a forged path can't reach this method.
        """
        result = self.client.storage.from_(bucket).download(path)
        # supabase-py returns bytes for download; surface as-is so callers
        # can write to disk with `Path.write_bytes`.
        return result
