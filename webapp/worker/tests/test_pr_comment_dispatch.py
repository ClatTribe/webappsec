"""Tests for the PR comment dispatcher (Tier II #7).

The dispatcher is best-effort: any failure must be swallowed so it
never blocks the scan-finalize path. Tests cover:

  - No-op when wrapper_origin is missing or empty.
  - No-op when the scan has no PR context (no github_pull_request_number).
  - No-op when the worker_internal_secret is missing.
  - Successful POST hits the right URL with X-Worker-Secret + json body.
  - HTTP-level errors (timeout, 4xx, 5xx) are logged but don't raise.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from strix_worker.pr_comment_dispatch import dispatch_pr_comment


# ---------------------------------------------------------------------------
# Fake Supabase shim — only the calls the dispatcher makes
# ---------------------------------------------------------------------------


class _FakeTable:
    def __init__(self, rows: dict[str, dict[str, Any] | None]) -> None:
        self._rows = rows
        self._table: str | None = None
        self._mode: str | None = None

    def select(self, _cols: str) -> "_FakeTable":
        return self

    def eq(self, _col: str, _val: Any) -> "_FakeTable":
        return self

    def maybe_single(self) -> "_FakeTable":
        return self

    def execute(self) -> Any:
        return SimpleNamespace(data=self._rows.get(self._table or "", None))


class _FakeClient:
    def __init__(self, scans: dict[str, Any] | None, settings: dict[str, Any] | None) -> None:
        self._scans = scans
        self._settings = settings

    def from_(self, table: str) -> _FakeTable:
        t = _FakeTable({"scans": self._scans, "tensorshield_settings": self._settings})
        t._table = table
        return t


class _FakeSupabase:
    def __init__(self, scans: dict[str, Any] | None, settings: dict[str, Any] | None) -> None:
        self.client = _FakeClient(scans, settings)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


def test_dispatch_noop_when_wrapper_origin_missing() -> None:
    sb = _FakeSupabase({"github_pull_request_number": 5}, {"worker_internal_secret": "s"})
    with patch("strix_worker.pr_comment_dispatch.httpx.post") as mock_post:
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin=None)
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="")
    mock_post.assert_not_called()


def test_dispatch_noop_when_no_pr_context() -> None:
    # Scan row with no github_pull_request_number should silently skip.
    sb = _FakeSupabase({"id": "abc", "github_pull_request_number": None}, {"worker_internal_secret": "s"})
    with patch("strix_worker.pr_comment_dispatch.httpx.post") as mock_post:
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com")
    mock_post.assert_not_called()


def test_dispatch_noop_when_settings_missing_secret() -> None:
    sb = _FakeSupabase({"id": "abc", "github_pull_request_number": 7}, None)
    with patch("strix_worker.pr_comment_dispatch.httpx.post") as mock_post:
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com")
    mock_post.assert_not_called()


def test_dispatch_noop_when_secret_empty_string() -> None:
    sb = _FakeSupabase(
        {"id": "abc", "github_pull_request_number": 7},
        {"worker_internal_secret": ""},
    )
    with patch("strix_worker.pr_comment_dispatch.httpx.post") as mock_post:
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com")
    mock_post.assert_not_called()


def test_dispatch_posts_to_correct_url_with_secret_header() -> None:
    sb = _FakeSupabase(
        {"id": "abc", "github_pull_request_number": 42},
        {"worker_internal_secret": "supersecret"},
    )
    fake_resp = SimpleNamespace(status_code=200, text="")
    with patch("strix_worker.pr_comment_dispatch.httpx.post", return_value=fake_resp) as mock_post:
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com/")

    mock_post.assert_called_once()
    _, kwargs = mock_post.call_args
    assert "https://app.example.com/api/scans/abc/pr-comment" in mock_post.call_args[0]
    assert kwargs["headers"]["X-Worker-Secret"] == "supersecret"
    assert kwargs["headers"]["Content-Type"] == "application/json"
    assert kwargs["json"] == {}


def test_dispatch_swallows_http_request_error() -> None:
    """A network-level error must NOT raise — finish_scan path is downstream."""
    sb = _FakeSupabase(
        {"id": "abc", "github_pull_request_number": 1},
        {"worker_internal_secret": "s"},
    )
    with patch(
        "strix_worker.pr_comment_dispatch.httpx.post",
        side_effect=httpx.ConnectError("connection refused"),
    ):
        # Must not raise.
        dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com")


def test_dispatch_swallows_4xx_5xx() -> None:
    sb = _FakeSupabase(
        {"id": "abc", "github_pull_request_number": 1},
        {"worker_internal_secret": "s"},
    )
    for code in (400, 401, 412, 500, 502):
        fake = SimpleNamespace(status_code=code, text=f"err{code}")
        with patch("strix_worker.pr_comment_dispatch.httpx.post", return_value=fake):
            # Must not raise.
            dispatch_pr_comment(sb, scan_id="abc", wrapper_origin="https://app.example.com")


def test_dispatch_swallows_fetch_crash() -> None:
    """An exception inside the supabase fetch path is logged + swallowed,
    not propagated. This guards against the finish_scan call chain being
    taken down by a stale-row read or schema drift."""

    class _CrashClient:
        def from_(self, _table: str) -> Any:
            raise RuntimeError("schema drift")

    class _CrashSupabase:
        client = _CrashClient()

    with patch("strix_worker.pr_comment_dispatch.httpx.post") as mock_post:
        dispatch_pr_comment(_CrashSupabase(), scan_id="x", wrapper_origin="https://app.example.com")  # type: ignore[arg-type]
    mock_post.assert_not_called()
