"""Tests for the subdomain auto-discovery flow.

The unit-level concern is `_normalise_subdomains` — it has to be tight,
because crt.sh returns multi-line, sometimes-malformed values that we
write straight into the DB. The integration-level concern (the worker
hits crt.sh on a real `target_discovery_requested` notify) is exercised
by `test_supabase_workflows.py`'s discovery test against the live DB.
"""

from __future__ import annotations

import pytest

from strix_worker.discovery import (
    MAX_DISCOVERIES_PER_TARGET,
    _normalise_subdomains,
)


class TestNormaliseSubdomains:
    def test_dedupes_and_sorts(self) -> None:
        out = _normalise_subdomains(
            ["api.acme.com", "API.acme.com", "blog.acme.com"], parent="acme.com"
        )
        assert out == ["api.acme.com", "blog.acme.com"]

    def test_drops_wildcards_or_strips_the_star(self) -> None:
        out = _normalise_subdomains(
            ["*.acme.com", "*.api.acme.com"], parent="acme.com"
        )
        # *.acme.com → acme.com, which is the parent and gets dropped.
        # *.api.acme.com → api.acme.com, kept.
        assert out == ["api.acme.com"]

    def test_drops_parent_itself(self) -> None:
        out = _normalise_subdomains(
            ["acme.com", "api.acme.com"], parent="acme.com"
        )
        assert out == ["api.acme.com"]

    def test_drops_unrelated_domains(self) -> None:
        # crt.sh occasionally returns SANs from sibling certs that match the
        # query string but aren't actually under the parent. Defensive filter.
        out = _normalise_subdomains(
            ["api.acme.com", "evil-acme.com.attacker.com", "fake-acme.com"],
            parent="acme.com",
        )
        assert out == ["api.acme.com"]

    def test_drops_emails(self) -> None:
        out = _normalise_subdomains(
            ["postmaster@acme.com", "api.acme.com"], parent="acme.com"
        )
        assert out == ["api.acme.com"]

    def test_strips_trailing_dot_and_lowercases(self) -> None:
        out = _normalise_subdomains(
            ["API.ACME.COM.", "blog.acme.com"], parent="acme.com"
        )
        assert out == ["api.acme.com", "blog.acme.com"]

    def test_caps_at_max(self) -> None:
        many = [f"sub{i}.acme.com" for i in range(MAX_DISCOVERIES_PER_TARGET + 50)]
        out = _normalise_subdomains(many, parent="acme.com")
        assert len(out) == MAX_DISCOVERIES_PER_TARGET
        # Sorted, so the cap drops the lexicographically-largest — that's
        # arbitrary but stable.
        assert out[0] == "sub0.acme.com"

    def test_empty_input(self) -> None:
        assert _normalise_subdomains([], parent="acme.com") == []

    def test_blank_strings_dropped(self) -> None:
        out = _normalise_subdomains(
            ["", "   ", "api.acme.com", "\n"], parent="acme.com"
        )
        assert out == ["api.acme.com"]

    def test_parent_with_unusual_casing(self) -> None:
        # Caller passes parent normalised already, but the function's own
        # normalisation should still hold.
        out = _normalise_subdomains(
            ["api.ACME.com", "blog.acme.COM"], parent="acme.com"
        )
        assert out == ["api.acme.com", "blog.acme.com"]
