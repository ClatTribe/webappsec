"""Thin wrapper around the Supabase Python client for the worker.

All worker operations go through service-role; we centralize that here so we never
accidentally use the anon key.
"""

from __future__ import annotations

from typing import Any

from supabase import Client, create_client

from .config import WorkerConfig


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
