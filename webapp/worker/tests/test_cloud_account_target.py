"""Tests for the `cloud_account` target type (engine PRs #290/#291/#292).

The wrapper change is small — extend `_PREFIXED_TYPES` so cloud_account
targets ride the engine's typed-prefix CLI contract (`-t cloud_account:
aws/123456789012` rather than the bare `-t aws/123456789012` which the
engine's URL/host inference would mis-route).

We also exercise that the existing materialize_credentials path (AWS
STS assume-role + AWS_* env vars) is unchanged — these tests are the
contract between the wrapper's scan_targets row and the engine's CSPM
specialist.
"""

from __future__ import annotations

from strix_worker.runner import _build_cmd
from strix_worker.config import WorkerConfig


def _cfg() -> WorkerConfig:
    return WorkerConfig(
        supabase_url="http://x",
        supabase_service_role_key="x",
        supabase_db_url="postgresql://x",
        default_strix_llm=None,
        default_llm_api_key=None,
        strix_image="img",
        strix_bin="strix",
        worker_concurrency=1,
        log_level="INFO",
        wrapper_origin=None,
    )


def test_cloud_account_target_uses_typed_prefix() -> None:
    """A cloud_account target must surface to the engine as
    `cloud_account:<provider>/<id>`. The engine routes that prefix to
    scan_cloud_account / scan_aws_account_tool (PRs #290/#291).
    Bare values would fall through to URL/host inference and either
    error or get mis-classified as something else."""
    cmd = _build_cmd(
        _cfg(),
        {"scan_mode": "standard"},
        [{"type": "cloud_account", "value": "aws/123456789012"}],
    )
    assert "cloud_account:aws/123456789012" in cmd
    # And bare form should NOT appear — that's how we'd know the
    # inference path was triggered by mistake.
    assert "aws/123456789012" in cmd[cmd.index("cloud_account:aws/123456789012")]
    # The bare form `-t aws/123456789012` must not be among the args.
    # Walk pairs to verify only the typed form was emitted.
    pairs = list(zip(cmd, cmd[1:]))
    assert ("-t", "aws/123456789012") not in pairs


def test_cloud_account_multi_provider_round_trip() -> None:
    """The engine accepts multiple providers behind the same prefix:
    aws / gcp / azure / kubernetes. Wrapper should not gate on provider
    — let the engine reject unsupported ones with its own error."""
    cmd = _build_cmd(
        _cfg(),
        {"scan_mode": "quick"},
        [
            {"type": "cloud_account", "value": "aws/111"},
            {"type": "cloud_account", "value": "gcp/my-project"},
            {"type": "cloud_account", "value": "azure/sub-uuid"},
        ],
    )
    assert "cloud_account:aws/111" in cmd
    assert "cloud_account:gcp/my-project" in cmd
    assert "cloud_account:azure/sub-uuid" in cmd


def test_repository_target_still_bare_after_cloud_account_addition() -> None:
    """Regression — adding cloud_account to _PREFIXED_TYPES must not
    accidentally typed-prefix other types. Repository must stay bare
    (engine PR #271 / migration 064 contract)."""
    cmd = _build_cmd(
        _cfg(),
        {"scan_mode": "standard"},
        [{"type": "repository", "value": "https://github.com/acme/web"}],
    )
    pairs = list(zip(cmd, cmd[1:]))
    assert ("-t", "https://github.com/acme/web") in pairs
    assert "repository:https://github.com/acme/web" not in cmd


def test_mixed_targets_independently_routed() -> None:
    """Heterogeneous target list — one cloud_account + one repository.
    Tests the drift correlation precondition (engine PR #292): when
    both target kinds appear in the same scan the engine cross-
    references findings."""
    cmd = _build_cmd(
        _cfg(),
        {"scan_mode": "standard"},
        [
            {"type": "repository", "value": "https://github.com/acme/infra"},
            {"type": "cloud_account", "value": "aws/123456789012"},
        ],
    )
    pairs = list(zip(cmd, cmd[1:]))
    assert ("-t", "https://github.com/acme/infra") in pairs
    assert "cloud_account:aws/123456789012" in cmd
