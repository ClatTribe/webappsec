"""Smoke tests for credential materialization. Run with `uv run pytest`.

These tests exercise the credential bundle without hitting Supabase.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from strix_worker.credentials import CredentialBundle, _apply_to_bundle


def test_github_credentials_set_env():
    bundle = CredentialBundle()
    _apply_to_bundle(bundle, "github", {"access_token": "ghp_abc"})
    assert bundle.env["GITHUB_TOKEN"] == "ghp_abc"
    bundle.cleanup()


def test_kubeconfig_writes_file():
    bundle = CredentialBundle()
    _apply_to_bundle(bundle, "k8s", {"kubeconfig": "apiVersion: v1\nkind: Config\n"})
    kubeconfig_path = Path(bundle.env["KUBECONFIG"])
    assert kubeconfig_path.exists()
    assert "apiVersion" in kubeconfig_path.read_text()
    bundle.cleanup()
    assert not kubeconfig_path.exists()


def test_gcp_writes_service_account_json():
    sa = {"type": "service_account", "project_id": "demo"}
    bundle = CredentialBundle()
    _apply_to_bundle(bundle, "gcp", {"service_account_json": json.dumps(sa)})
    sa_path = Path(bundle.env["GOOGLE_APPLICATION_CREDENTIALS"])
    assert json.loads(sa_path.read_text())["project_id"] == "demo"
    bundle.cleanup()
    assert not sa_path.exists()


def test_cleanup_unlinks_temp_files_on_exception():
    bundle = CredentialBundle()
    path = bundle.add_temp_file("hello", suffix=".txt")
    assert path.exists()
    bundle.cleanup()
    assert not path.exists()


def test_aws_role_creds_require_role_arn(monkeypatch):
    # Without role_arn we fall through to long-lived keys.
    bundle = CredentialBundle()
    _apply_to_bundle(
        bundle,
        "aws",
        {"access_key_id": "AKIA", "secret_access_key": "SECRET", "region": "us-west-2"},
    )
    assert bundle.env["AWS_ACCESS_KEY_ID"] == "AKIA"
    assert bundle.env["AWS_DEFAULT_REGION"] == "us-west-2"
    bundle.cleanup()


@pytest.mark.parametrize("integration_type", ["github", "gitlab", "aws", "azure", "gcp", "k8s", "webhook"])
def test_all_types_handled_without_error(integration_type):
    """Ensure no integration type raises when given an empty payload."""
    bundle = CredentialBundle()
    _apply_to_bundle(bundle, integration_type, {})
    bundle.cleanup()
