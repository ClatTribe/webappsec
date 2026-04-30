"""Tests for the inline finding-triage module.

The contract under test:
  - `triage_scan_findings` fetches findings detected in this scan, calls the
    LLM for each one that lacks an `ai_assessment`, and writes the result
    back via `findings.update`.
  - With `reassess=False` (the runner's default), already-assessed findings
    are silently skipped — recurring findings carrying their old assessment
    forward shouldn't burn fresh tokens.
  - A per-finding LLM failure must not stop the rest. Triage is best-effort.

Real `litellm.acompletion` is monkey-patched out — the tests assert the
right calls go in/out of the Supabase write path, not real LLM behaviour.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from strix_worker import triage


SCAN_ID = "11111111-1111-1111-1111-111111111111"


# ---------------------------------------------------------------------------
# Minimal Supabase fake. Only implements the call-shapes triage uses:
#   sb.client.table("findings").select("*").eq("last_seen_scan_id", X).execute()
#   sb.client.table("findings").update({...}).eq("id", X).execute()
# ---------------------------------------------------------------------------


class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data


class _Q:
    def __init__(self, sb: "FakeSupabase", *, op: str, payload: Any = None) -> None:
        self._sb = sb
        self._op = op  # "select" | "update"
        self._payload = payload
        self._eq: dict[str, Any] = {}

    def eq(self, col: str, val: Any) -> "_Q":
        self._eq[col] = val
        return self

    def execute(self) -> _Result:
        if self._op == "select":
            scan_id = self._eq.get("last_seen_scan_id")
            rows = [r for r in self._sb.findings if r.get("last_seen_scan_id") == scan_id]
            return _Result(rows)
        # update
        target_id = self._eq.get("id")
        for r in self._sb.findings:
            if r["id"] == target_id:
                r.update(self._payload)
        self._sb.update_calls.append({"id": target_id, **self._payload})
        return _Result(None)


class _Table:
    def __init__(self, sb: "FakeSupabase") -> None:
        self._sb = sb

    def select(self, _cols: str) -> _Q:
        return _Q(self._sb, op="select")

    def update(self, payload: dict[str, Any]) -> _Q:
        return _Q(self._sb, op="update", payload=payload)


class _Client:
    def __init__(self, sb: "FakeSupabase") -> None:
        self._sb = sb

    def table(self, _name: str) -> _Table:
        return _Table(self._sb)


class FakeSupabase:
    def __init__(self, findings: list[dict[str, Any]]) -> None:
        self.findings = findings
        self.update_calls: list[dict[str, Any]] = []
        self.client = _Client(self)


def _finding(
    fid: str,
    *,
    has_assessment: bool = False,
    title: str = "Generic finding",
    severity: str = "high",
    last_seen: str = SCAN_ID,
) -> dict[str, Any]:
    return {
        "id": fid,
        "vuln_id": f"vuln-{fid}",
        "title": title,
        "severity": severity,
        "cvss": 7.5,
        "cwe": "CWE-79",
        "target": "https://example.com",
        "endpoint": "/foo",
        "method": "GET",
        "description_md": "A description.",
        "status": "open",
        "times_seen": 1,
        "last_seen_scan_id": last_seen,
        "ai_assessment": (
            {"urgency": "monitor", "model": "old"} if has_assessment else None
        ),
    }


def _fake_response(payload: dict[str, Any]) -> Any:
    """Mirror litellm's response shape just enough for triage to read it."""
    class _Msg:
        content = json.dumps(payload)

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    return _Resp()


_GOOD_ASSESSMENT = {
    "urgency": "fix_now",
    "reachability": "external_unauthenticated",
    "confidence": 0.9,
    "is_likely_false_positive": False,
    "reasoning": "Real and exposed.",
    "recommended_action": "Patch the input handler.",
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_writes_assessment_for_each_unassessed_finding(monkeypatch):
    sb = FakeSupabase(
        [
            _finding("a"),
            _finding("b", has_assessment=True),  # should be skipped
            _finding("c"),
        ]
    )
    mock = AsyncMock(return_value=_fake_response(_GOOD_ASSESSMENT))
    monkeypatch.setattr(triage.litellm, "acompletion", mock)

    stats = await triage.triage_scan_findings(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake-key"
    )

    assert stats.candidates == 2
    assert stats.success == 2
    assert stats.failed == 0
    assert stats.skipped == 1  # the already-assessed one
    # Only the two unassessed got LLM calls.
    assert mock.await_count == 2
    # Both updates happened against the right ids.
    updated_ids = {u["id"] for u in sb.update_calls}
    assert updated_ids == {"a", "c"}
    # Payload includes the model name annotated by `assess_one`.
    for call in sb.update_calls:
        assessment = call["ai_assessment"]
        assert assessment["urgency"] == "fix_now"
        assert assessment["model"] == "gemini/gemini-2.5-flash"


@pytest.mark.asyncio
async def test_no_candidates_returns_clean_stats(monkeypatch):
    # All findings already assessed -> nothing to do.
    sb = FakeSupabase([_finding("a", has_assessment=True), _finding("b", has_assessment=True)])
    mock = AsyncMock(return_value=_fake_response(_GOOD_ASSESSMENT))
    monkeypatch.setattr(triage.litellm, "acompletion", mock)

    stats = await triage.triage_scan_findings(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake-key"
    )

    assert stats.candidates == 0
    assert stats.success == 0
    assert stats.failed == 0
    assert stats.skipped == 2
    assert mock.await_count == 0
    assert sb.update_calls == []


@pytest.mark.asyncio
async def test_reassess_overwrites_existing_assessments(monkeypatch):
    sb = FakeSupabase([_finding("a", has_assessment=True), _finding("b")])
    mock = AsyncMock(return_value=_fake_response(_GOOD_ASSESSMENT))
    monkeypatch.setattr(triage.litellm, "acompletion", mock)

    stats = await triage.triage_scan_findings(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake-key", reassess=True,
    )

    assert stats.candidates == 2
    assert stats.success == 2
    assert mock.await_count == 2


@pytest.mark.asyncio
async def test_per_finding_failure_does_not_stop_the_rest(monkeypatch):
    sb = FakeSupabase([_finding("a"), _finding("b"), _finding("c")])
    # Fail on the second call only; others succeed.
    side_effects: list[Any] = [
        _fake_response(_GOOD_ASSESSMENT),
        RuntimeError("LLM exploded"),
        _fake_response(_GOOD_ASSESSMENT),
    ]
    mock = AsyncMock(side_effect=side_effects)
    monkeypatch.setattr(triage.litellm, "acompletion", mock)

    stats = await triage.triage_scan_findings(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake-key"
    )

    assert stats.candidates == 3
    assert stats.success == 2
    assert stats.failed == 1
    # Two updates landed (a + c). The failure on 'b' didn't write anything.
    assert {u["id"] for u in sb.update_calls} == {"a", "c"}


@pytest.mark.asyncio
async def test_only_findings_for_this_scan_are_triaged(monkeypatch):
    other_scan = "99999999-9999-9999-9999-999999999999"
    sb = FakeSupabase(
        [
            _finding("mine-1", last_seen=SCAN_ID),
            _finding("other-1", last_seen=other_scan),
            _finding("mine-2", last_seen=SCAN_ID),
        ]
    )
    mock = AsyncMock(return_value=_fake_response(_GOOD_ASSESSMENT))
    monkeypatch.setattr(triage.litellm, "acompletion", mock)

    stats = await triage.triage_scan_findings(
        sb, SCAN_ID, model="gemini/gemini-2.5-flash", api_key="fake-key"
    )

    # `other-1` is filtered out by last_seen_scan_id.
    assert stats.candidates == 2
    assert mock.await_count == 2
    assert {u["id"] for u in sb.update_calls} == {"mine-1", "mine-2"}


@pytest.mark.asyncio
async def test_assess_one_includes_code_context_in_prompt(monkeypatch):
    """When code_context is supplied, the user prompt must carry a clearly
    delimited 'Source code context' section the LLM can read."""
    captured: dict[str, Any] = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        return _fake_response(_GOOD_ASSESSMENT)

    monkeypatch.setattr(triage.litellm, "acompletion", _capture)

    snippet = "### webapp/api/handler.py  (around line 42)\n```\n42 | dangerous_call(user_input)\n```"
    out = await triage.assess_one(
        _finding("a"),
        model="gemini/gemini-2.5-flash",
        api_key="k",
        code_context=snippet,
    )
    assert out["urgency"] == "fix_now"

    user_msg = next(m for m in captured["messages"] if m["role"] == "user")
    assert "Source code context" in user_msg["content"]
    assert "dangerous_call(user_input)" in user_msg["content"]


@pytest.mark.asyncio
async def test_assess_one_omits_code_context_section_when_none(monkeypatch):
    """No code_context → no 'Source code context' header in the prompt."""
    captured: dict[str, Any] = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        return _fake_response(_GOOD_ASSESSMENT)

    monkeypatch.setattr(triage.litellm, "acompletion", _capture)

    await triage.assess_one(
        _finding("a"), model="gemini/gemini-2.5-flash", api_key="k", code_context=None
    )
    user_msg = next(m for m in captured["messages"] if m["role"] == "user")
    assert "Source code context" not in user_msg["content"]


@pytest.mark.asyncio
async def test_triage_passes_code_context_for_local_code_targets(monkeypatch, tmp_path):
    """Integration: triage_scan_findings + a local_code target on disk
    should result in code context being attached to the triage prompt."""
    # Set up a tiny on-disk source root the gather_for_finding can resolve.
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "auth.py").write_text(
        "\n".join(f"line_{i}" for i in range(1, 50)) + "\n"
    )

    finding = _finding("local-1")
    finding["description_md"] = "Issue at `src/auth.py:20`"
    sb = FakeSupabase([finding])

    captured: list[dict[str, Any]] = []

    async def _capture(**kwargs):
        captured.append(kwargs)
        return _fake_response(_GOOD_ASSESSMENT)

    monkeypatch.setattr(triage.litellm, "acompletion", _capture)

    stats = await triage.triage_scan_findings(
        sb,
        SCAN_ID,
        model="gemini/gemini-2.5-flash",
        api_key="fake-key",
        scan_targets=[{"type": "local_code", "value": str(tmp_path)}],
    )
    assert stats.success == 1
    user_msg = next(m for m in captured[0]["messages"] if m["role"] == "user")
    assert "Source code context" in user_msg["content"]
    assert "### src/auth.py" in user_msg["content"]
    assert "line_20" in user_msg["content"]


@pytest.mark.asyncio
async def test_assess_one_strips_fenced_json(monkeypatch):
    """Some providers wrap JSON in ```json fences. _coerce_assessment must strip them."""
    fenced = "```json\n" + json.dumps(_GOOD_ASSESSMENT) + "\n```"

    class _Msg:
        content = fenced

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    monkeypatch.setattr(triage.litellm, "acompletion", AsyncMock(return_value=_Resp()))

    out = await triage.assess_one(_finding("a"), model="gemini/gemini-2.5-flash", api_key="k")
    assert out["urgency"] == "fix_now"
    assert out["reachability"] == "external_unauthenticated"
    assert out["model"] == "gemini/gemini-2.5-flash"
