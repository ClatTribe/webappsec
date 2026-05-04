"""Tests for the plain-language scan-summary module."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from strix_worker import summary


# ---------------------------------------------------------------------------
# Minimal Supabase fake — enough for summarize_scan's I/O path:
#   sb.client.table("scans").select("*, scan_targets(*)").eq("id", X).single().execute()
#   sb.client.table("findings").select(...).eq("last_seen_scan_id", X).execute()
#   sb.client.table("scan_events").select(...).eq("scan_id", X).like(...).execute()
#   sb.client.rpc("scan_recurrence_summary", {...}).execute()
#   sb.client.table("scans").update({"summary": ...}).eq("id", X).execute()
# ---------------------------------------------------------------------------


SCAN_ID = "11111111-1111-1111-1111-111111111111"


class _Q:
    def __init__(self, sb, table_name, *, op, payload=None):
        self._sb = sb
        self._table = table_name
        self._op = op
        self._payload = payload
        self._eq = {}
        self._like = None
        self._single = False

    def select(self, *_): return self
    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self
    def eq(self, col, val):
        self._eq[col] = val
        return self
    def like(self, col, pattern):
        self._like = (col, pattern)
        return self
    def single(self):
        self._single = True
        return self

    def execute(self):
        from types import SimpleNamespace

        if self._op == "select" and self._table == "scans" and self._single:
            return SimpleNamespace(data=self._sb.scan_row)
        if self._op == "select" and self._table == "findings":
            return SimpleNamespace(data=self._sb.findings)
        if self._op == "select" and self._table == "scan_events":
            return SimpleNamespace(data=self._sb.scan_events)
        if self._op == "update" and self._table == "scans":
            self._sb.summary_writes.append(self._payload)
            return SimpleNamespace(data=None)
        return SimpleNamespace(data=None)


class FakeSupabase:
    def __init__(self, *, scan_row, findings, scan_events, recurrence):
        self.scan_row = scan_row
        self.findings = findings
        self.scan_events = scan_events
        self.recurrence = recurrence
        self.summary_writes: list[dict[str, Any]] = []
        self.client = self

    def table(self, name):
        return _Q(self, name, op="select")

    def rpc(self, fn_name, args):
        from types import SimpleNamespace

        class _Exec:
            def execute(_self):
                if fn_name == "scan_recurrence_summary":
                    return SimpleNamespace(data=self.recurrence)
                return SimpleNamespace(data=None)

        return _Exec()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def _make_sb(*, findings_count=2, with_recurrence=False):
    findings = [
        {
            "title": "SQL injection on /search",
            "severity": "high",
            "status": "open",
            "ai_assessment": {"urgency": "fix_now"},
            "poc_md": "curl '/search?q=...' returned the user table.",
        },
        {
            "title": "Missing X-Frame-Options on /admin",
            "severity": "medium",
            "status": "open",
            "ai_assessment": {"urgency": "monitor"},
            "poc_md": None,
        },
    ][:findings_count]
    scan = {
        "id": SCAN_ID,
        "run_name": "summary-test-scan",
        "scan_mode": "quick",
        "scan_targets": [{"type": "web_application", "value": "https://acme.com"}],
    }
    events = [
        {"event_type": "tool.execution.started", "payload": {"url": "https://acme.com/search"}},
        {"event_type": "tool.execution.started", "payload": {"url": "https://acme.com/admin"}},
        {"event_type": "tool.execution.started", "payload": {"url": "https://acme.com/login"}},
    ]
    recurrence = (
        {"total": 1, "still_active": 1, "fixed": 0, "dismissed": 0, "reopened": 0}
        if with_recurrence else None
    )
    return FakeSupabase(scan_row=scan, findings=findings, scan_events=events, recurrence=recurrence)


@pytest.mark.asyncio
async def test_summarize_scan_writes_payload(monkeypatch):
    sb = _make_sb()
    fake_text = "Two short paragraphs.\n\nNotable: one fix-now SQLi."

    monkeypatch.setattr(
        summary.litellm,
        "acompletion",
        AsyncMock(return_value=_resp(json.dumps({"text": fake_text}))),
    )

    out = await summary.summarize_scan(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake"
    )
    assert out is not None
    assert out["text"] == fake_text
    assert out["stats"]["findings_total"] == 2
    assert out["stats"]["fix_now"] == 1
    assert out["stats"]["monitor"] == 1
    assert out["stats"]["endpoints_touched"] == 3
    # Persisted to scans.summary.
    assert len(sb.summary_writes) == 1
    assert sb.summary_writes[0]["summary"]["text"] == fake_text


@pytest.mark.asyncio
async def test_summarize_scan_returns_none_on_llm_failure(monkeypatch):
    sb = _make_sb()
    monkeypatch.setattr(
        summary.litellm,
        "acompletion",
        AsyncMock(side_effect=summary.litellm.APIError(500, "boom", "x", "y")),
    )

    out = await summary.summarize_scan(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake"
    )
    assert out is None
    # Nothing persisted — failure must be silent.
    assert sb.summary_writes == []


@pytest.mark.asyncio
async def test_summary_prompt_includes_recurrence_when_present(monkeypatch):
    sb = _make_sb(with_recurrence=True)
    captured: dict[str, Any] = {}

    async def _cap(**kwargs):
        captured.update(kwargs)
        return _resp(json.dumps({"text": "ok"}))

    monkeypatch.setattr(summary.litellm, "acompletion", _cap)

    await summary.summarize_scan(sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake")
    user_msg = next(m for m in captured["messages"] if m["role"] == "user")
    assert "Recurrence:" in user_msg["content"]
    assert "still active: 1" in user_msg["content"]


@pytest.mark.asyncio
async def test_summarize_scan_prefers_engine_run_summary_json(monkeypatch, tmp_path):
    """When run_summary.json is present, the engine's authored summary is
    used directly — no LLM call. Doctrine: the engine's source-of-truth
    output beats wrapper-side derivation."""
    sb = _make_sb()

    # Plant the engine artifact at the path summarize_scan reads from.
    workdir = tmp_path / "strix-runs" / SCAN_ID / "strix_runs" / "fake-run"
    workdir.mkdir(parents=True)
    engine_doc = {
        "schema_version": 1,
        "summary_text": "Scanned acme.com (domain) in 2.1m. Found 1 medium SSRF and 2 info notes.",
        "duration_seconds": 126.4,
        "findings_summary": {
            "total": 3,
            "by_severity": {"medium": 1, "info": 2},
            "by_category": {"ssrf": 1, "info_disclosure": 2},
        },
        "top_findings": [{"id": "vuln-001", "title": "SSRF on /api/import", "severity": "medium"}],
        "checks": {"total": 38, "by_result": {"vulnerable": 1, "not_vulnerable": 28, "inconclusive": 9}},
        "generated_at": "2026-05-08T12:00:00Z",
    }
    (workdir / "run_summary.json").write_text(json.dumps(engine_doc))

    # Repoint the summary module's hard-coded `/tmp/strix-runs` prefix at
    # our tmp dir so the test is hermetic.
    monkeypatch.setattr(summary, "_read_engine_run_summary",
        lambda scan_id: engine_doc if scan_id == SCAN_ID else None)

    # Even if litellm is callable, it must NOT be invoked on the engine path.
    llm_called = {"count": 0}
    async def _should_not_be_called(**kwargs):
        llm_called["count"] += 1
        return _resp("{}")
    monkeypatch.setattr(summary.litellm, "acompletion", _should_not_be_called)

    out = await summary.summarize_scan(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake",
    )

    assert out is not None
    assert out["text"] == engine_doc["summary_text"]
    assert out["source"] == "engine_run_summary_json"
    assert out["model"] == "engine"
    assert out["stats"]["findings_total"] == 3
    assert out["stats"]["fix_soon"] == 1  # one medium → fix_soon bucket
    assert out["stats"]["by_category"]["ssrf"] == 1
    assert out["duration_seconds"] == 126.4
    assert llm_called["count"] == 0  # critical: LLM was NOT called
    # Persisted to scans.summary as a single update.
    assert len(sb.summary_writes) == 1
    assert sb.summary_writes[0]["summary"]["source"] == "engine_run_summary_json"


def _resp(content: str):
    """litellm-shaped response object with a single message."""
    class _Msg:
        pass
    msg = _Msg()
    msg.content = content

    class _Choice:
        pass
    ch = _Choice()
    ch.message = msg

    class _Resp:
        choices = [ch]

    return _Resp()
