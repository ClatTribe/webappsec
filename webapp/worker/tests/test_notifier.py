"""Tests for the Slack scan-completion notifier (migration 037 / Tier A).

The notifier composes a Slack-blocks payload from finding counts +
final scan state and POSTs to the org's webhook. Tests cover:
  - Payload composition (headline, severity counts, fallback text,
    deep-link presence/absence based on wrapper_origin)
  - Silent no-op paths (no webhook, RPC error, request crash)
  - HTTP error handling (4xx/5xx response logged but not re-raised)
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from strix_worker.notifier import (
    notify_scan_completion,
    _compose_message,
    _headline,
    forward_agent_message_to_slack,
    _compose_chat_bridge_payload,
    _strip_markdown_for_fallback,
)


# ---------------------------------------------------------------------------
# Fake Supabase shim — minimal surface for the notifier
# ---------------------------------------------------------------------------


class _FakeTable:
    def __init__(self, scan: dict[str, Any], findings: list[dict[str, Any]]) -> None:
        self._scan = scan
        self._findings = findings
        self._mode: str | None = None

    def select(self, _cols: str) -> "_FakeTable":
        return self

    def eq(self, _col: str, _val: Any) -> "_FakeTable":
        return self

    def limit(self, _n: int) -> "_FakeTable":
        return self

    def single(self) -> "_FakeTable":
        self._mode = "single"
        return self

    def execute(self) -> Any:
        from types import SimpleNamespace
        if self._mode == "single":
            return SimpleNamespace(data=self._scan)
        return SimpleNamespace(data=self._findings)


class _FakeClient:
    def __init__(self, scan: dict[str, Any], findings: list[dict[str, Any]]) -> None:
        self._scan = scan
        self._findings = findings

    def table(self, name: str) -> _FakeTable:
        if name == "scans":
            return _FakeTable(self._scan, [])
        if name == "findings":
            return _FakeTable({}, self._findings)
        return _FakeTable({}, [])


class FakeSupabaseForNotifier:
    """Just enough of WorkerSupabase to satisfy the notifier."""

    def __init__(
        self,
        scan: dict[str, Any] | None = None,
        findings: list[dict[str, Any]] | None = None,
        webhook: str | None = None,
    ) -> None:
        self._webhook = webhook
        self.client = _FakeClient(scan or {}, findings or [])

    def decrypt_org_slack_webhook(self, scan_id: str) -> str | None:
        return self._webhook


# ---------------------------------------------------------------------------
# _headline / _compose_message — pure functions, no I/O
# ---------------------------------------------------------------------------


def test_headline_emoji_and_text_for_each_terminal_state():
    """Each terminal state gets a distinct emoji and a one-line headline.
    The crit/high split inside `completed` keeps the most-actionable
    cases (red 🚨 / amber ⚠️) loud and the clean-finish path quiet."""
    crit_emoji, crit_text = _headline("completed", None, {"critical": 2, "high": 0, "medium": 0, "low": 0, "info": 0})
    assert "🚨" in crit_emoji
    assert "2 critical" in crit_text

    high_emoji, high_text = _headline("completed", None, {"critical": 0, "high": 1, "medium": 0, "low": 0, "info": 0})
    assert "⚠️" in high_emoji
    assert "1 high finding" in high_text

    low_emoji, low_text = _headline("completed", None, {"critical": 0, "high": 0, "medium": 0, "low": 5, "info": 2})
    assert "✅" in low_emoji
    assert "low/info" in low_text

    clean_emoji, clean_text = _headline("completed", None, {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0})
    assert "✅" in clean_emoji
    assert "no findings" in clean_text.lower()

    cancel_emoji, cancel_text = _headline("cancelled", None, {})
    assert "🛑" in cancel_emoji
    assert "cancelled" in cancel_text.lower()

    budget_emoji, budget_text = _headline("failed", "scan stopped: budget exceeded", {})
    assert "💸" in budget_emoji
    assert "budget" in budget_text.lower()

    fail_emoji, fail_text = _headline("failed", "kernel oops", {})
    assert "❌" in fail_emoji
    assert "kernel oops" in fail_text


def test_compose_message_includes_severity_counts_and_fallback_text():
    payload = _compose_message(
        scan={"run_name": "Q3 audit run", "scan_mode": "deep", "total_cost": 1.2345},
        scan_id="11111111-1111-1111-1111-111111111111",
        final_status="completed",
        error_message=None,
        counts={"critical": 1, "high": 0, "medium": 3, "low": 0, "info": 5},
        wrapper_origin="https://strix.example.com",
    )
    assert "text" in payload  # fallback for push notifications
    assert "Q3 audit run" in payload["text"]
    blocks = payload["blocks"]
    section_text = blocks[0]["text"]["text"]
    assert "Q3 audit run" in section_text
    assert "deep" in section_text
    assert "$1.2345" in section_text
    assert "1 critical" in section_text
    assert "3 medium" in section_text
    assert "5 info" in section_text
    # Action button with deep-link
    actions = blocks[1]
    assert actions["type"] == "actions"
    assert (
        actions["elements"][0]["url"]
        == "https://strix.example.com/scans/11111111-1111-1111-1111-111111111111"
    )


def test_compose_message_omits_actions_when_no_wrapper_origin():
    """Without a configured wrapper origin the notification still goes
    out — just no clickable button."""
    payload = _compose_message(
        scan={"run_name": "anon run", "scan_mode": "quick"},
        scan_id="abc",
        final_status="completed",
        error_message=None,
        counts={"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0},
        wrapper_origin=None,
    )
    assert all(b["type"] != "actions" for b in payload["blocks"])


def test_compose_message_handles_no_findings_with_em_dash():
    payload = _compose_message(
        scan={"run_name": "clean", "scan_mode": "quick"},
        scan_id="abc",
        final_status="completed",
        error_message=None,
        counts={"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0},
        wrapper_origin=None,
    )
    section_text = payload["blocks"][0]["text"]["text"]
    assert "_no findings_" in section_text


# ---------------------------------------------------------------------------
# notify_scan_completion — integration with the fake httpx + supabase
# ---------------------------------------------------------------------------


def test_notify_silently_skips_when_no_webhook(caplog):
    """Most orgs won't have a webhook configured — the notifier must
    no-op silently (debug-level log only) so the worker's finalisation
    isn't littered with warnings about unconfigured channels."""
    sb = FakeSupabaseForNotifier(webhook=None)
    with patch("strix_worker.notifier.httpx.Client") as mock_client:
        notify_scan_completion(
            sb,
            scan_id="abc",
            org_id="org",
            final_status="completed",
            error_message=None,
            wrapper_origin=None,
        )
        # httpx must NOT be invoked on the no-webhook path.
        mock_client.assert_not_called()


def test_notify_posts_to_webhook_with_correct_payload_shape():
    """Happy path: the webhook URL gets a POST with a Slack-blocks
    payload whose first block is the section + the right run name."""
    sb = FakeSupabaseForNotifier(
        scan={"run_name": "audit-1", "scan_mode": "standard", "total_cost": 0.42},
        findings=[
            {"severity": "critical"},
            {"severity": "low"},
            {"severity": "low"},
        ],
        webhook="https://hooks.slack.com/services/T/B/x",
    )
    captured: dict[str, Any] = {}

    class _MockResp:
        status_code = 200
        text = ""

    class _MockClient:
        def __init__(self, *_, **__):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *_):
            return False
        def post(self, url: str, json: dict[str, Any]) -> _MockResp:
            captured["url"] = url
            captured["json"] = json
            return _MockResp()

    with patch("strix_worker.notifier.httpx.Client", _MockClient):
        notify_scan_completion(
            sb,
            scan_id="abc",
            org_id="org",
            final_status="completed",
            error_message=None,
            wrapper_origin="https://strix.example.com",
        )

    assert captured["url"] == "https://hooks.slack.com/services/T/B/x"
    section_text = captured["json"]["blocks"][0]["text"]["text"]
    assert "audit-1" in section_text
    assert "1 critical" in section_text
    assert "2 low" in section_text


def test_notify_swallows_http_errors():
    """A 5xx from Slack must not raise. The notifier logs and returns."""
    sb = FakeSupabaseForNotifier(
        scan={"run_name": "x", "scan_mode": "quick"},
        findings=[],
        webhook="https://hooks.slack.com/services/T/B/x",
    )

    class _ErrResp:
        status_code = 503
        text = "service unavailable"

    class _MockClient:
        def __init__(self, *_, **__):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *_):
            return False
        def post(self, *_, **__):
            return _ErrResp()

    with patch("strix_worker.notifier.httpx.Client", _MockClient):
        # Must not raise.
        notify_scan_completion(
            sb,
            scan_id="abc",
            org_id="org",
            final_status="completed",
            error_message=None,
            wrapper_origin=None,
        )


def test_notify_swallows_request_exception():
    """A connection / timeout exception must not raise either — the
    `try` around the whole POST keeps it contained."""
    sb = FakeSupabaseForNotifier(
        scan={"run_name": "x", "scan_mode": "quick"},
        findings=[],
        webhook="https://hooks.slack.com/services/T/B/x",
    )

    class _MockClient:
        def __init__(self, *_, **__):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *_):
            return False
        def post(self, *_, **__):
            raise ConnectionError("network down")

    with patch("strix_worker.notifier.httpx.Client", _MockClient):
        notify_scan_completion(
            sb,
            scan_id="abc",
            org_id="org",
            final_status="failed",
            error_message="kernel oops",
            wrapper_origin=None,
        )


# Required to satisfy pyright/pytest's import path resolution.
@pytest.fixture(scope="session", autouse=True)
def _no_cleanup() -> None:
    return None


# ---------------------------------------------------------------------------
# Phase D v1 — chat-bridge: forward_agent_message_to_slack
# ---------------------------------------------------------------------------


class _BridgeFakeTable:
    """Minimal table fake for the chat-bridge path — returns a single
    agent_messages row by id when .single().execute() is called."""

    def __init__(self, row: dict[str, Any] | None) -> None:
        self._row = row

    def select(self, _cols: str) -> "_BridgeFakeTable":
        return self

    def eq(self, _col: str, _val: Any) -> "_BridgeFakeTable":
        return self

    def single(self) -> "_BridgeFakeTable":
        return self

    def execute(self) -> Any:
        from types import SimpleNamespace
        return SimpleNamespace(data=self._row)


class _BridgeFakeClient:
    def __init__(self, msg_row: dict[str, Any] | None) -> None:
        self._msg_row = msg_row

    def table(self, name: str) -> _BridgeFakeTable:
        if name == "agent_messages":
            return _BridgeFakeTable(self._msg_row)
        return _BridgeFakeTable(None)


class _BridgeFakeSb:
    def __init__(
        self,
        msg_row: dict[str, Any] | None,
        webhook: str | None,
    ) -> None:
        self.client = _BridgeFakeClient(msg_row)
        self._webhook = webhook

    def decrypt_org_slack_webhook_by_org(self, org_id: str) -> str | None:
        return self._webhook


def test_compose_chat_bridge_payload_renders_text_block_with_strix_attribution():
    """First text block becomes Slack body + a context line."""
    msg = {
        "id": "m1",
        "blocks": [
            {"type": "text", "markdown": "🛑 **Critical** — SQL injection at /api/login"},
            {"type": "finding_ref", "finding_id": "f1"},
        ],
    }
    payload = _compose_chat_bridge_payload(msg)
    assert payload is not None
    # mrkdwn body carries the text + the finding_ref context line
    section = payload["blocks"][0]["text"]["text"]
    assert "Critical" in section
    assert "SQL injection" in section
    assert "finding_ref" in section
    # context block carries the Strix attribution
    ctx = payload["blocks"][1]["elements"][0]["text"]
    assert "Strix" in ctx
    # fallback text is plain — markdown stripped
    assert "**" not in payload["text"]
    assert "Critical" in payload["text"]


def test_compose_chat_bridge_payload_returns_none_for_empty_blocks():
    assert _compose_chat_bridge_payload({"id": "m1", "blocks": []}) is None
    assert _compose_chat_bridge_payload({"id": "m1", "blocks": None}) is None
    assert _compose_chat_bridge_payload({"id": "m1"}) is None


def test_compose_chat_bridge_payload_skips_opaque_unrenderable_blocks():
    msg = {
        "id": "m1",
        "blocks": [
            {"type": "future_unknown_block", "weird": "data"},
        ],
    }
    assert _compose_chat_bridge_payload(msg) is None


def test_strip_markdown_for_fallback_removes_decorators_and_truncates():
    raw = "**bold** _ital_ `code` " + ("x" * 250)
    out = _strip_markdown_for_fallback(raw)
    assert "**" not in out
    assert "`" not in out
    assert len(out) <= 201  # 200 + ellipsis


@pytest.mark.asyncio
async def test_forward_agent_message_skips_when_no_webhook():
    """An org with slack_bridge_enabled but a missing/decryptable webhook
    silently no-ops (no POST attempted)."""
    msg_row = {
        "id": "m1", "org_id": "o1", "thread_id": "t1", "role": "agent",
        "blocks": [{"type": "text", "markdown": "hello"}],
        "citations": [], "created_at": "now",
    }
    sb = _BridgeFakeSb(msg_row=msg_row, webhook=None)
    with patch("strix_worker.notifier.httpx.Client") as mock_client:
        await forward_agent_message_to_slack(sb, "m1")
        mock_client.assert_not_called()


@pytest.mark.asyncio
async def test_forward_agent_message_posts_to_webhook():
    """End-to-end: message + webhook → Slack POST happens with the
    composed payload."""
    msg_row = {
        "id": "m1", "org_id": "o1", "thread_id": "t1", "role": "agent",
        "blocks": [{"type": "text", "markdown": "🛑 Dismissed"}],
        "citations": [], "created_at": "now",
    }
    sb = _BridgeFakeSb(
        msg_row=msg_row,
        webhook="https://hooks.slack.com/services/T1/B1/secret",
    )

    posts: list[Any] = []

    class _MockClient:
        def __init__(self, *_a, **_kw): pass
        def __enter__(self): return self
        def __exit__(self, *_a): pass
        def post(self, url: str, json: dict) -> Any:
            posts.append((url, json))
            from types import SimpleNamespace
            return SimpleNamespace(status_code=200, text="ok")

    with patch("strix_worker.notifier.httpx.Client", _MockClient):
        await forward_agent_message_to_slack(sb, "m1")

    assert len(posts) == 1
    url, body = posts[0]
    assert url.startswith("https://hooks.slack.com/services/")
    assert "blocks" in body
    assert "Dismissed" in body["text"]


@pytest.mark.asyncio
async def test_forward_agent_message_swallows_http_errors():
    msg_row = {
        "id": "m1", "org_id": "o1", "thread_id": "t1", "role": "agent",
        "blocks": [{"type": "text", "markdown": "hi"}],
        "citations": [], "created_at": "now",
    }
    sb = _BridgeFakeSb(
        msg_row=msg_row,
        webhook="https://hooks.slack.com/services/T/B/x",
    )

    class _ExplodingClient:
        def __init__(self, *_a, **_kw): pass
        def __enter__(self): return self
        def __exit__(self, *_a): pass
        def post(self, *_a, **_kw):
            raise RuntimeError("network down")

    with patch("strix_worker.notifier.httpx.Client", _ExplodingClient):
        # Must not raise — bridge is best-effort.
        await forward_agent_message_to_slack(sb, "m1")


@pytest.mark.asyncio
async def test_forward_agent_message_skips_when_message_vanished():
    """Message id pointing at a deleted row — silent no-op."""
    sb = _BridgeFakeSb(msg_row=None, webhook="https://hooks.slack.com/services/T/B/x")
    with patch("strix_worker.notifier.httpx.Client") as mock_client:
        await forward_agent_message_to_slack(sb, "m1")
        mock_client.assert_not_called()
