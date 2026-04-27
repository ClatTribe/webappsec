"""Decrypt integration credentials and turn them into env vars / temp files for the Strix subprocess.

Every credential lives in process memory only for the duration of one scan. Temp files are
unlinked after the scan finishes, regardless of outcome.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3

from .supabase_client import WorkerSupabase


logger = logging.getLogger(__name__)


class CredentialBundle:
    """Holds decrypted credentials plus any temp files created from them."""

    def __init__(self) -> None:
        self.env: dict[str, str] = {}
        self._temp_files: list[Path] = []

    def add_env(self, key: str, value: str) -> None:
        self.env[key] = value

    def add_temp_file(self, contents: str | bytes, *, suffix: str = "") -> Path:
        fd, path_str = tempfile.mkstemp(suffix=suffix)
        try:
            data = contents.encode() if isinstance(contents, str) else contents
            os.write(fd, data)
        finally:
            os.close(fd)
        path = Path(path_str)
        path.chmod(0o600)
        self._temp_files.append(path)
        return path

    def cleanup(self) -> None:
        for path in self._temp_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("failed to unlink temp file %s", path)
        self._temp_files.clear()
        # Best-effort wipe of env values from this dict.
        self.env.clear()


@contextmanager
def materialize_credentials(
    sb: WorkerSupabase,
    scan_id: str,
    integrations: list[dict[str, Any]],
) -> Iterator[CredentialBundle]:
    """Decrypt every linked integration and surface them as env / files.

    Yields a CredentialBundle. Always cleans up on exit (success or exception).
    """
    bundle = CredentialBundle()
    try:
        for integration in integrations:
            int_id = integration["id"]
            int_type = integration["type"]
            try:
                plaintext = sb.decrypt_integration(scan_id, int_id)
            except Exception as e:  # noqa: BLE001
                logger.error("failed to decrypt integration %s: %s", int_id, e)
                raise

            try:
                creds = json.loads(plaintext)
            except json.JSONDecodeError:
                # Some types store raw text (e.g. kubeconfig)
                creds = {"raw": plaintext}

            _apply_to_bundle(bundle, int_type, creds)

        yield bundle
    finally:
        bundle.cleanup()


def _apply_to_bundle(bundle: CredentialBundle, int_type: str, creds: dict[str, Any]) -> None:
    if int_type == "github":
        token = creds.get("access_token")
        if token:
            bundle.add_env("GITHUB_TOKEN", token)

    elif int_type == "gitlab":
        token = creds.get("access_token")
        if token:
            bundle.add_env("GITLAB_TOKEN", token)

    elif int_type == "aws":
        # Cross-account role assume — produces short-lived creds.
        role_arn = creds.get("role_arn")
        external_id = creds.get("external_id")
        region = creds.get("region", "us-east-1")
        if role_arn:
            sts = boto3.client("sts")
            kwargs = {
                "RoleArn": role_arn,
                "RoleSessionName": "strix-scan",
                "DurationSeconds": 3600,
            }
            if external_id:
                kwargs["ExternalId"] = external_id
            assumed = sts.assume_role(**kwargs)["Credentials"]
            bundle.add_env("AWS_ACCESS_KEY_ID", assumed["AccessKeyId"])
            bundle.add_env("AWS_SECRET_ACCESS_KEY", assumed["SecretAccessKey"])
            bundle.add_env("AWS_SESSION_TOKEN", assumed["SessionToken"])
            bundle.add_env("AWS_DEFAULT_REGION", region)
        else:
            # Fallback: long-lived access key (less safe).
            if creds.get("access_key_id"):
                bundle.add_env("AWS_ACCESS_KEY_ID", creds["access_key_id"])
                bundle.add_env("AWS_SECRET_ACCESS_KEY", creds["secret_access_key"])
                bundle.add_env("AWS_DEFAULT_REGION", creds.get("region", "us-east-1"))

    elif int_type == "azure":
        # Service principal.
        for k_src, k_dst in [
            ("client_id", "AZURE_CLIENT_ID"),
            ("client_secret", "AZURE_CLIENT_SECRET"),
            ("tenant_id", "AZURE_TENANT_ID"),
        ]:
            if v := creds.get(k_src):
                bundle.add_env(k_dst, v)

    elif int_type == "gcp":
        # Service account JSON. Strix expects a file path.
        sa_json = creds.get("service_account_json") or creds.get("raw")
        if sa_json:
            path = bundle.add_temp_file(sa_json, suffix=".json")
            bundle.add_env("GOOGLE_APPLICATION_CREDENTIALS", str(path))

    elif int_type == "k8s":
        # Kubeconfig as a file.
        kubeconfig = creds.get("kubeconfig") or creds.get("raw")
        if kubeconfig:
            path = bundle.add_temp_file(kubeconfig, suffix=".yaml")
            bundle.add_env("KUBECONFIG", str(path))

    elif int_type == "webhook":
        # Currently informational; consumed by the worker's notification step, not the agent.
        pass
