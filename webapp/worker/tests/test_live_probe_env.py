"""Tests for the MOAK live-probe consent env forwarding (wishlist §18.7).

The worker reads `targets.config.allow_live_probe` and forwards
`STRIX_MOAK_LIVE_PROBE=1` to the engine subprocess when the target's
operator opted in. Engine PR #278 gates the LiveProbe stage on this
env var, so it's the wrapper's safety-toggle equivalent.
"""

from __future__ import annotations

from strix_worker.config import WorkerConfig
from strix_worker.runner import _build_env


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


def test_live_probe_off_when_target_config_missing_flag() -> None:
    """Default off — wrapper never opts in unless the operator
    explicitly sets allow_live_probe on the target config."""
    env = _build_env(
        _cfg(),
        {"scan_mode": "standard", "targets": {"type": "web_application", "config": {}}},
        cred_env={},
        llm_provider="openai/gpt-5",
        llm_api_key="sk-x",
    )
    assert "STRIX_MOAK_LIVE_PROBE" not in env


def test_live_probe_on_when_target_config_opts_in() -> None:
    """When the target config has allow_live_probe=true, forward
    STRIX_MOAK_LIVE_PROBE=1 so the engine's LiveProbe stage runs."""
    env = _build_env(
        _cfg(),
        {
            "scan_mode": "standard",
            "targets": {"type": "api", "config": {"allow_live_probe": True}},
        },
        cred_env={},
        llm_provider="openai/gpt-5",
        llm_api_key="sk-x",
    )
    assert env.get("STRIX_MOAK_LIVE_PROBE") == "1"


def test_live_probe_off_when_target_config_value_is_string() -> None:
    """Defensive — only the boolean true opts in. A truthy string
    is NOT treated as consent (lets a stale form serialisation be
    caught instead of silently enabling live probes)."""
    env = _build_env(
        _cfg(),
        {
            "scan_mode": "standard",
            "targets": {"type": "api", "config": {"allow_live_probe": "true"}},
        },
        cred_env={},
        llm_provider="openai/gpt-5",
        llm_api_key="sk-x",
    )
    assert "STRIX_MOAK_LIVE_PROBE" not in env


def test_live_probe_off_when_targets_missing() -> None:
    """Scan with no parent target hydrated yet — no crash, no enable."""
    env = _build_env(
        _cfg(),
        {"scan_mode": "quick"},
        cred_env={},
        llm_provider="openai/gpt-5",
        llm_api_key="sk-x",
    )
    assert "STRIX_MOAK_LIVE_PROBE" not in env


def test_live_probe_works_on_cloud_account_target() -> None:
    """cloud_account is one of the three target types that accept the
    toggle (alongside web_application and api). Test that the env
    forwarding is type-agnostic — it just reads from parent_cfg."""
    env = _build_env(
        _cfg(),
        {
            "scan_mode": "standard",
            "targets": {
                "type": "cloud_account",
                "config": {"provider": "aws", "allow_live_probe": True},
            },
        },
        cred_env={},
        llm_provider="openai/gpt-5",
        llm_api_key="sk-x",
    )
    assert env.get("STRIX_MOAK_LIVE_PROBE") == "1"
