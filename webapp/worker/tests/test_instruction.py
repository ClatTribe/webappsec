"""Tests for the per-target-type instruction augmenter (roadmap §9.1).

These pin the contract between the wrapper-side `targets.config` shape
(defined in TS at `webapp/frontend/lib/target-config.ts`) and what we
actually pass to Strix via `--instruction`. Drift here is a real bug —
each test calls out the field name it locks in.
"""

from __future__ import annotations

import pytest

from strix_worker.instruction import build_instruction


# ---------------------------------------------------------------------------
# Base behaviour
# ---------------------------------------------------------------------------


def test_returns_none_for_empty_scan() -> None:
    assert build_instruction({}) is None


def test_returns_only_user_text_when_no_config() -> None:
    out = build_instruction({"instruction_text": "look for SQLi"})
    assert out == "look for SQLi"


def test_returns_none_when_user_text_is_blank_and_no_config() -> None:
    assert build_instruction({"instruction_text": "   "}) is None


def test_user_text_comes_first() -> None:
    """The user's intent precedes our augmentation — the agent reads top to
    bottom so we don't want to push their actual brief below boilerplate."""
    out = build_instruction(
        {
            "instruction_text": "go fast",
            "targets": {
                "type": "repository",
                "config": {"branch": "develop"},
            },
        }
    )
    assert out is not None
    assert out.split("\n")[0] == "go fast"


def test_no_augmentation_section_when_user_text_only() -> None:
    """Empty config shouldn't emit an "Additional configuration" header."""
    out = build_instruction(
        {"instruction_text": "look around", "targets": {"type": "repository", "config": {}}}
    )
    assert out == "look around"


# ---------------------------------------------------------------------------
# repository
# ---------------------------------------------------------------------------


def test_repository_branch_appears_in_instruction() -> None:
    out = build_instruction(
        {"targets": {"type": "repository", "config": {"branch": "develop"}}}
    )
    assert out is not None
    assert "develop" in out
    assert "branch" in out


def test_repository_subdirectory_appears_in_instruction() -> None:
    out = build_instruction(
        {"targets": {"type": "repository", "config": {"subdirectory": "apps/api"}}}
    )
    assert out is not None
    assert "apps/api" in out


def test_repository_blank_branch_is_ignored() -> None:
    out = build_instruction(
        {"targets": {"type": "repository", "config": {"branch": "   "}}}
    )
    assert out is None


# ---------------------------------------------------------------------------
# web_application
# ---------------------------------------------------------------------------


def test_web_application_crawl_seeds_listed() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "web_application",
                "config": {"crawl_seeds": ["/login", "/api"]},
            }
        }
    )
    assert out is not None
    assert "/login" in out
    assert "/api" in out


def test_web_application_rate_limit_explicit() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "web_application",
                "config": {"rate_limit_qps": 10},
            }
        }
    )
    assert out is not None
    assert "10" in out
    assert "production" in out  # warns the agent


def test_web_application_zero_or_negative_qps_ignored() -> None:
    """Sanitised on the frontend, but defence in depth."""
    out = build_instruction(
        {
            "targets": {
                "type": "web_application",
                "config": {"rate_limit_qps": 0},
            }
        }
    )
    assert out is None


# ---------------------------------------------------------------------------
# domain
# ---------------------------------------------------------------------------


def test_domain_subdomain_excludes_listed() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "domain",
                "config": {"subdomain_excludes": ["*-staging", "internal-*"]},
            }
        }
    )
    assert out is not None
    assert "*-staging" in out
    assert "internal-*" in out


# ---------------------------------------------------------------------------
# ip_address
# ---------------------------------------------------------------------------


def test_ip_port_spec_appears() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "ip_address",
                "config": {"port_spec": "80,443,8080-8090"},
            }
        }
    )
    assert out is not None
    assert "80,443,8080-8090" in out


def test_ip_protocols_tcp() -> None:
    out = build_instruction(
        {"targets": {"type": "ip_address", "config": {"protocols": "tcp"}}}
    )
    assert out is not None
    assert "TCP" in out


def test_ip_protocols_both() -> None:
    out = build_instruction(
        {"targets": {"type": "ip_address", "config": {"protocols": "both"}}}
    )
    assert out is not None
    assert "TCP and UDP" in out


def test_ip_protocols_unknown_value_ignored() -> None:
    out = build_instruction(
        {"targets": {"type": "ip_address", "config": {"protocols": "icmp"}}}
    )
    # No augmentation → None when there's nothing else either.
    assert out is None


# ---------------------------------------------------------------------------
# local_code
# ---------------------------------------------------------------------------


def test_local_code_path_excludes_listed() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "local_code",
                "config": {"path_excludes": ["node_modules", "vendor"]},
            }
        }
    )
    assert out is not None
    assert "node_modules" in out
    assert "vendor" in out


def test_local_code_language_hints_listed() -> None:
    out = build_instruction(
        {
            "targets": {
                "type": "local_code",
                "config": {"language_hints": ["python", "typescript"]},
            }
        }
    )
    assert out is not None
    assert "python" in out
    assert "typescript" in out


# ---------------------------------------------------------------------------
# Defensive paths
# ---------------------------------------------------------------------------


def test_unknown_target_type_is_silent() -> None:
    """A new target type added in a future migration shouldn't crash the
    augmenter — it just falls through."""
    out = build_instruction(
        {
            "instruction_text": "scan it",
            "targets": {"type": "container_image", "config": {"tag": "latest"}},
        }
    )
    assert out == "scan it"


def test_config_can_be_none() -> None:
    out = build_instruction(
        {"instruction_text": "scan", "targets": {"type": "repository", "config": None}}
    )
    assert out == "scan"


def test_config_can_be_non_dict() -> None:
    """Defensive — bad data in the DB shouldn't break the worker."""
    out = build_instruction(
        {
            "instruction_text": "scan",
            "targets": {"type": "repository", "config": "not-a-dict"},
        }
    )
    assert out == "scan"
