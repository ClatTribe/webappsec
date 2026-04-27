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
        """Fetch a scan with its targets and integrations."""
        result = (
            self.client.table("scans")
            .select(
                "*, "
                "scan_targets(*), "
                "scan_integrations(integration_id, integrations(id, type, name, vault_secret_id, metadata))"
            )
            .eq("id", scan_id)
            .single()
            .execute()
        )
        return result.data

    def start_scan(self, scan_id: str) -> None:
        self.client.rpc("worker_start_scan", {"p_scan_id": scan_id}).execute()

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

    def decrypt_org_llm_key(self, scan_id: str) -> str | None:
        try:
            result = self.client.rpc(
                "worker_decrypt_org_llm_key", {"p_scan_id": scan_id}
            ).execute()
            return result.data
        except Exception:  # noqa: BLE001
            # No per-org key configured — fall back to default.
            return None

    # --- Storage ---------------------------------------------------------

    def upload_artifact(
        self, bucket: str, path: str, contents: bytes, content_type: str = "text/plain"
    ) -> None:
        self.client.storage.from_(bucket).upload(
            path, contents, {"content-type": content_type, "upsert": "true"}
        )
