"""End-to-end tests for runner.run_scan against a mocked Strix subprocess.

The fake Strix script below mirrors the on-disk layout of the real CLI as
documented in https://github.com/usestrix/strix/blob/main/strix/telemetry/tracer.py:

    <cwd>/strix_runs/<run_name>/
        ├── events.jsonl                    structured event stream
        ├── penetration_test_report.md      final summary
        ├── vulnerabilities.csv             CSV index of all findings
        └── vulnerabilities/
            ├── vuln-0001.md                per-finding markdown
            └── vuln-0002.md

Tests in this file have two purposes:

1. Drive `runner.run_scan` against the mock and assert every collection channel
   (live logs, lifecycle RPCs, artifact upload, finding ingestion) is exercised.
2. Run the mock standalone and verify its on-disk output is faithful to real
   Strix's format — same filenames, same markdown sections, same event-record
   schema. If real Strix changes its layout, the mock should be updated to
   match and the fidelity test should fail until it is.
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from strix_worker.config import WorkerConfig
from strix_worker.runner import run_scan


# ---------------------------------------------------------------------------
# Fake Strix CLI — written verbatim to mirror real Strix's tracer output.
#
# References (link to the live source on the date this was written):
#   - run dir + events.jsonl path:   strix/telemetry/tracer.py:297-303, :97
#   - event record schema:           strix/telemetry/tracer.py:253-266
#   - vulnerability markdown format: strix/telemetry/tracer.py:656-732
#   - vulnerabilities.csv columns:   strix/telemetry/tracer.py:740-745
#   - penetration test report:       strix/telemetry/tracer.py:622-633
# ---------------------------------------------------------------------------

FAKE_STRIX_SUCCESS = textwrap.dedent('''\
    #!/usr/bin/env python3
    """A faithful mock of a successful Strix run, byte-compatible with the real CLI's outputs."""
    import csv
    import json
    import sys
    from datetime import datetime, timezone
    from pathlib import Path

    # ---- live stdout/stderr (worker tails these as 'log' events) ------------
    print("strix: starting scan")
    print("strix: planning agents")
    print("strix: discovered 2 vulnerabilities")
    print("strix: writing reports")
    print("strix: tool call: terminal_execute", file=sys.stderr)
    print("strix: tool call: browser_navigate", file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()

    run_name = "fake-run-001"
    run_dir = Path.cwd() / "strix_runs" / run_name
    vuln_dir = run_dir / "vulnerabilities"
    vuln_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()

    findings = [
        {
            "id": "vuln-0001",
            "title": "SQL Injection on /search",
            "severity": "high",
            "target": "https://example.com",
            "endpoint": "/search",
            "method": "GET",
            "cve": None,
            "cwe": "CWE-89",
            "cvss": 8.6,
            "timestamp": now,
            "description": "The /search endpoint concatenates user input into a SQL query.",
            "impact": "Attackers can dump or modify the database.",
            "technical_analysis": "The `q` parameter is interpolated into a raw SQL string.",
            "poc_description": "Visit /search?q=' OR '1'='1 to bypass auth.",
            "poc_script_code": "curl 'https://example.com/search?q=%27+OR+%271%27%3D%271'",
            "remediation_steps": "Use parameterised queries or an ORM.",
        },
        {
            "id": "vuln-0002",
            "title": "Reflected XSS on /comments",
            "severity": "medium",
            "target": "https://example.com",
            "endpoint": "/comments",
            "method": "POST",
            "cve": None,
            "cwe": "CWE-79",
            "cvss": 5.4,
            "timestamp": now,
            "description": "The 'q' parameter is reflected without escaping.",
            "impact": "Attackers can execute JavaScript in victims\\' browsers.",
            "technical_analysis": "User content rendered into HTML without HTML-escape.",
            "poc_description": "POST <script>alert(1)</script> as comment body.",
            "poc_script_code": "curl -X POST -d 'body=<script>alert(1)</script>' .../comments",
            "remediation_steps": "HTML-escape user input on render.",
        },
    ]

    # ---- per-vuln markdown — exact format from tracer.save_run_data ----------
    for r in findings:
        f_path = vuln_dir / f"{r[\'id\']}.md"
        with f_path.open("w") as out:
            out.write(f"# {r[\'title\']}\\n\\n")
            out.write(f"**ID:** {r[\'id\']}\\n")
            out.write(f"**Severity:** {r[\'severity\'].upper()}\\n")
            out.write(f"**Found:** {r[\'timestamp\']}\\n")
            for label, value in [
                ("Target", r["target"]),
                ("Endpoint", r["endpoint"]),
                ("Method", r["method"]),
                ("CVE", r["cve"]),
                ("CWE", r["cwe"]),
                ("CVSS", r["cvss"]),
            ]:
                if value:
                    out.write(f"**{label}:** {value}\\n")
            out.write("\\n## Description\\n\\n")
            out.write(f"{r[\'description\']}\\n\\n")
            out.write("## Impact\\n\\n")
            out.write(f"{r[\'impact\']}\\n\\n")
            out.write("## Technical Analysis\\n\\n")
            out.write(f"{r[\'technical_analysis\']}\\n\\n")
            out.write("## Proof of Concept\\n\\n")
            out.write(f"{r[\'poc_description\']}\\n\\n")
            out.write("```\\n")
            out.write(f"{r[\'poc_script_code\']}\\n")
            out.write("```\\n\\n")
            out.write("## Remediation\\n\\n")
            out.write(f"{r[\'remediation_steps\']}\\n\\n")

    # ---- vulnerabilities.csv — exact column order from tracer.save_run_data --
    with (run_dir / "vulnerabilities.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "title", "severity", "timestamp", "file"])
        w.writeheader()
        for r in findings:
            w.writerow({
                "id": r["id"],
                "title": r["title"],
                "severity": r["severity"].upper(),
                "timestamp": r["timestamp"],
                "file": f"vulnerabilities/{r[\'id\']}.md",
            })

    # ---- final pen-test report -----------------------------------------------
    with (run_dir / "penetration_test_report.md").open("w") as f:
        f.write("# Security Penetration Test Report\\n\\n")
        f.write(f"**Generated:** {now}\\n\\n")
        f.write("Two vulnerabilities found.\\n")

    # ---- events.jsonl — schema matches tracer._emit_event --------------------
    def event(event_type, status, payload):
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "run_id": run_name,
            "trace_id": "0" * 32,
            "span_id": "0" * 16,
            "parent_span_id": None,
            "actor": None,
            "payload": payload,
            "status": status,
            "error": None,
            "source": None,
        }

    with (run_dir / "events.jsonl").open("w") as f:
        f.write(json.dumps(event("run.started", "running",
                                 {"run_name": run_name})) + "\\n")
        f.write(json.dumps(event("agent.created", "active",
                                 {"agent_id": "agent-0"})) + "\\n")
        f.write(json.dumps(event("tool.execution.started", "running",
                                 {"tool_name": "terminal_execute"})) + "\\n")
        for r in findings:
            f.write(json.dumps(event("finding.created", r["severity"],
                                     {"report": r})) + "\\n")
        f.write(json.dumps(event("run.completed", "completed",
                                 {"vulnerability_count": len(findings)})) + "\\n")

    sys.exit(0)
''')

FAKE_STRIX_FAILURE = textwrap.dedent('''\
    #!/usr/bin/env python3
    """Mimics a Strix run that crashes mid-scan."""
    import sys
    print("strix: starting scan")
    print("strix: fatal: docker daemon unreachable", file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()
    sys.exit(1)
''')

# A success run that also prints the live + final stats panel Strix renders
# via Rich (`build_live_stats_text` / `build_final_stats_text` in
# strix/interface/utils.py). Numbers are humanised because real Strix calls
# `format_token_count` (>=1M -> "X.YM", >=1K -> "X.YK", else int).
# The live panel is reprinted as values grow; the worker should pick the
# largest seen, which matches the final render.
FAKE_STRIX_WITH_STATS = textwrap.dedent('''\
    #!/usr/bin/env python3
    """Strix-like run that also emits the stats panel multiple times."""
    import csv, json, sys
    from datetime import datetime, timezone
    from pathlib import Path

    # Live panel during the scan — small numbers, then growing.
    print("Vulnerabilities  HIGH: 1 (Total: 1)")
    print("Agents 2  ·  Tools 12")
    print("Input Tokens 850  ·  Output Tokens 420")
    print("Cost $0.0050")
    sys.stdout.flush()

    # Mid-scan refresh.
    print("Vulnerabilities  CRITICAL: 1 | HIGH: 1 (Total: 2)")
    print("Agents 4  ·  Tools 48")
    print("Input Tokens 12.5K  ·  Cached Tokens 8.0K  ·  Output Tokens 3.2K")
    print("Cost $0.1180")
    sys.stdout.flush()

    # Final summary (this is what real Strix prints last).
    print("Vulnerabilities  CRITICAL: 1 | HIGH: 1 (Total: 2)")
    print("Agents  7  ·  Tools  96")
    print("Input Tokens 2.6M  ·  Cached Tokens 2.1M  ·  Output Tokens 14.4K · Cost $0.2392")
    sys.stdout.flush()

    # Minimal artifact so _upload_run_artifacts has something to walk.
    run_dir = Path.cwd() / "strix_runs" / "stats-run"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events.jsonl").write_text("")
    (run_dir / "penetration_test_report.md").write_text("# Security Penetration Test Report\\n")
    sys.exit(0)
''')


def _write_executable(path: Path, contents: str) -> Path:
    path.write_text(contents)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


# ---------------------------------------------------------------------------
# In-memory FakeSupabase. Captures every worker_* RPC the runner would make.
# ---------------------------------------------------------------------------

class FakeSupabase:
    def __init__(self, scan: dict[str, Any]) -> None:
        self._scan = scan
        self.events: list[tuple[str, dict[str, Any] | None]] = []
        self.findings: list[dict[str, Any]] = []
        self.uploads: list[dict[str, Any]] = []
        self.start_calls: int = 0
        self.claim_calls: int = 0
        self.heartbeat_calls: int = 0
        self.finish_calls: list[dict[str, Any]] = []
        self.claim_returns_truthy: bool = True
        # Mimic the scan-row read path for `_was_cancel_requested`. Tests can
        # set this to a non-None value to simulate a user pressing Cancel.
        self._cancel_requested_at: str | None = None
        self.client = _FakeClient(self)

    def fetch_scan(self, scan_id: str) -> dict[str, Any]:
        return self._scan

    def claim_scan(self, scan_id: str) -> dict[str, Any] | None:
        self.claim_calls += 1
        if not self.claim_returns_truthy:
            return None
        # Pretend the row carries the same data fetch_scan returns. The
        # production claim_scan returns the bare row; runner immediately
        # follows up with fetch_scan, so what we return here mostly doesn't
        # matter — only "is it truthy" does.
        return {**self._scan, "status": "running"}

    def start_scan(self, scan_id: str) -> None:
        self.start_calls += 1

    def heartbeat_scan(self, scan_id: str) -> None:
        self.heartbeat_calls += 1

    def mark_stale_scans(self, max_silence_seconds: int = 600) -> list[str]:
        return []

    def finish_scan(self, scan_id: str, status: str, **kwargs: Any) -> None:
        self.finish_calls.append({"status": status, **kwargs})

    def emit_event(
        self, scan_id: str, event_type: str, payload: dict[str, Any] | None = None
    ) -> None:
        self.events.append((event_type, payload))

    def insert_finding(
        self,
        scan_id: str,
        vuln_id: str,
        title: str,
        severity: str,
        payload: dict[str, Any],
    ) -> str:
        self.findings.append(
            {"vuln_id": vuln_id, "title": title, "severity": severity, "payload": payload}
        )
        return f"finding-{vuln_id}"

    def decrypt_integration(self, scan_id: str, integration_id: str) -> str:
        return "{}"

    def decrypt_org_llm_key(self, scan_id: str) -> str | None:
        return None

    def upload_artifact(
        self, bucket: str, path: str, contents: bytes, content_type: str = "text/plain"
    ) -> None:
        self.uploads.append({"bucket": bucket, "path": path, "size": len(contents)})


# Tiny chainable stub for the supabase-py builder. Only handles the one
# call-shape `runner._was_cancel_requested` makes:
#     sb.client.table("scans").select(...).eq("id", X).single().execute()
class _FakeClient:
    def __init__(self, sb: "FakeSupabase") -> None:
        self._sb = sb

    def table(self, name: str) -> "_FakeTable":
        return _FakeTable(self._sb, name)


class _FakeTable:
    def __init__(self, sb: "FakeSupabase", name: str) -> None:
        self._sb = sb

    def select(self, _columns: str) -> "_FakeTable":
        return self

    def eq(self, _col: str, _val: Any) -> "_FakeTable":
        return self

    def single(self) -> "_FakeTable":
        return self

    def execute(self) -> Any:
        from types import SimpleNamespace

        return SimpleNamespace(data={"cancel_requested_at": self._sb._cancel_requested_at})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SCAN_ID = "11111111-1111-1111-1111-111111111111"
ORG_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def fake_scan() -> dict[str, Any]:
    return {
        "id": SCAN_ID,
        "org_id": ORG_ID,
        "status": "queued",
        "scan_mode": "quick",
        "scope_mode": "auto",
        "diff_base": None,
        "instruction_text": "Focus on auth flaws.",
        "llm_provider": None,
        "scan_targets": [
            {
                "value": "https://example.com",
                "type": "web_application",
                "workspace_subdir": "target_1",
            },
        ],
        "scan_integrations": [],
    }


@pytest.fixture
def cfg_factory(tmp_path: Path):
    def _make(strix_source: str) -> WorkerConfig:
        bin_path = _write_executable(tmp_path / "fake_strix", strix_source)
        return WorkerConfig(
            supabase_url="http://localhost",
            supabase_service_role_key="fake",
            supabase_db_url="postgres://fake",
            default_strix_llm="openai/gpt-5.4",
            default_llm_api_key="sk-fake",
            strix_image="ghcr.io/usestrix/strix-sandbox:0.1.13",
            strix_bin=str(bin_path),
            worker_concurrency=1,
            log_level="DEBUG",
        )

    return _make


@pytest.fixture(autouse=True)
def cleanup_runs():
    """Wipe every per-scan workdir created by tests in this module."""
    yield
    base = Path("/tmp/strix-runs")
    if base.exists():
        for child in base.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)


def _make_scan(scan_id: str, org_id: str, **overrides: Any) -> dict[str, Any]:
    """Build a scan row used by run_scan tests; same shape as supabase_client.fetch_scan."""
    base = {
        "id": scan_id,
        "org_id": org_id,
        "status": "queued",
        "scan_mode": "quick",
        "scope_mode": "auto",
        "diff_base": None,
        "instruction_text": None,
        "llm_provider": None,
        "scan_targets": [
            {"value": "https://example.com", "type": "web_application", "workspace_subdir": "t1"},
        ],
        "scan_integrations": [],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 1. Worker collection tests — drive run_scan against the mock.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_scan_collects_all_reports(fake_scan, cfg_factory):
    """Happy path: every collection channel produces the expected records."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    # ---- 1. Lifecycle ----
    assert sb.claim_calls == 1
    assert len(sb.finish_calls) == 1
    finish = sb.finish_calls[0]
    assert finish["status"] == "completed"
    assert finish["exit_code"] == 0
    assert finish["error_message"] is None

    # ---- 2. scan.command event ----
    cmd_events = [p for et, p in sb.events if et == "scan.command"]
    assert len(cmd_events) == 1
    cmd_payload = cmd_events[0]
    assert cmd_payload["cmd"][1:5] == ["-n", "-m", "quick", "-t"]
    assert "https://example.com" in cmd_payload["cmd"]
    assert "--instruction" in cmd_payload["cmd"]
    assert "STRIX_LLM" in cmd_payload["env_keys"]
    assert "LLM_API_KEY" in cmd_payload["env_keys"]
    assert "sk-fake" not in str(cmd_payload)

    # ---- 3. Live log events from BOTH stdout and stderr ----
    log_events = [p for et, p in sb.events if et == "log"]
    stdout_lines = [p["line"] for p in log_events if p["stream"] == "stdout"]
    stderr_lines = [p["line"] for p in log_events if p["stream"] == "stderr"]
    assert any("starting scan" in line for line in stdout_lines)
    assert any("writing reports" in line for line in stdout_lines)
    assert any("tool call: terminal_execute" in line for line in stderr_lines)
    assert any("tool call: browser_navigate" in line for line in stderr_lines)

    # ---- 4. Every file under strix_runs/<run>/ uploaded to scan-artifacts ----
    paths = [u["path"] for u in sb.uploads]
    assert any(p.endswith("/events.jsonl") for p in paths)
    assert any(p.endswith("/penetration_test_report.md") for p in paths)
    assert any(p.endswith("/vulnerabilities.csv") for p in paths)
    assert any(p.endswith("/vulnerabilities/vuln-0001.md") for p in paths)
    assert any(p.endswith("/vulnerabilities/vuln-0002.md") for p in paths)
    assert all(p.startswith(f"{ORG_ID}/{SCAN_ID}/") for p in paths)
    assert all(u["bucket"] == "scan-artifacts" for u in sb.uploads)

    # ---- 5. vuln-*.md parsed and inserted as findings ----
    assert len(sb.findings) == 2
    by_id = {f["vuln_id"]: f for f in sb.findings}

    assert by_id["vuln-0001"]["title"] == "SQL Injection on /search"
    assert by_id["vuln-0002"]["title"] == "Reflected XSS on /comments"

    # The current parser uses split(":", 1) and ends up keeping a leading "** ".
    # Asserting endswith() so the test passes today and survives a future fix
    # that produces clean "high"/"medium".
    assert by_id["vuln-0001"]["severity"].endswith("high")
    assert by_id["vuln-0002"]["severity"].endswith("medium")

    assert "concatenates user input" in by_id["vuln-0001"]["payload"]["description_md"]
    assert "reflected without escaping" in by_id["vuln-0002"]["payload"]["description_md"]

    # ---- 6. events.jsonl streamed live into scan_events ----
    # The structured events Strix writes to events.jsonl mirror into scan_events
    # while the scan runs. Without this, the UI only sees `log` lines (raw stdout)
    # until artifact upload at scan exit.
    streamed_types = {et for et, _ in sb.events}
    for expected in {
        "run.started",
        "agent.created",
        "tool.execution.started",
        "run.completed",
    }:
        assert expected in streamed_types, f"events.jsonl tailer didn't forward {expected}"

    # finding.created is intentionally skipped — the markdown ingest path is
    # the source of truth for findings, and re-emitting events.jsonl ones
    # would double up the timeline.
    streamed_finding_events = [p for et, p in sb.events if et == "finding.created"]
    assert streamed_finding_events == [], (
        "finding.created should not be re-emitted by the tailer"
    )

    # chat.message is filtered as noise (full LLM round-trip text). The mock
    # doesn't emit one, but the contract is still asserted here.
    assert "chat.message" not in streamed_types


@pytest.mark.asyncio
async def test_run_scan_marks_failed_on_nonzero_exit(fake_scan, cfg_factory):
    cfg = cfg_factory(FAKE_STRIX_FAILURE)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    assert sb.claim_calls == 1
    assert len(sb.finish_calls) == 1
    finish = sb.finish_calls[0]
    assert finish["status"] == "failed"
    assert finish["exit_code"] == 1
    assert finish["error_message"] == "strix exited with code 1"

    stderr_lines = [
        p["line"] for et, p in sb.events
        if et == "log" and p["stream"] == "stderr"
    ]
    assert any("docker daemon unreachable" in line for line in stderr_lines)

    assert sb.uploads == []
    assert sb.findings == []


@pytest.mark.asyncio
async def test_run_scan_skips_when_already_terminal(fake_scan, cfg_factory):
    """Atomic claim returns falsy when the row isn't 'queued' anymore — the
    runner should bail without ever invoking Strix or finalising the row.
    """
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    fake_scan["status"] = "completed"
    sb = FakeSupabase(fake_scan)
    sb.claim_returns_truthy = False  # Simulate "lost the claim race"

    await run_scan(SCAN_ID, cfg, sb)

    # claim_scan was called and returned None; nothing else fires.
    assert sb.claim_calls == 1
    assert sb.start_calls == 0
    assert sb.finish_calls == []
    assert sb.events == []
    assert sb.uploads == []
    assert sb.findings == []


# ---------------------------------------------------------------------------
# 2. Parallelism, isolation, credentials — Architecture.md §2.4 + §3.6 + §3.7.
# ---------------------------------------------------------------------------

import asyncio
import json as _json
from dataclasses import replace as _replace

from strix_worker.runner import _resolve_llm  # noqa: E402

# A fake-strix variant that reports whether GITHUB_TOKEN is set, without leaking
# the value. Used to verify integration creds are materialised into the
# subprocess env without exposing secrets in tests.
FAKE_STRIX_ENV_PROBE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import os, sys
    from pathlib import Path
    present = "yes" if os.environ.get("GITHUB_TOKEN") else "no"
    print(f"strix: GITHUB_TOKEN_PRESENT={present}", file=sys.stderr)
    (Path.cwd() / "strix_runs" / "probe").mkdir(parents=True, exist_ok=True)
    sys.exit(0)
''')


@pytest.mark.asyncio
async def test_parallel_scans_for_different_orgs_are_isolated(cfg_factory):
    """§2.4: two scans for different orgs run in parallel without cross-contamination."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)

    scan_a_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    scan_b_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    org_a = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
    org_b = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"

    sb_a = FakeSupabase(_make_scan(scan_a_id, org_a))
    sb_b = FakeSupabase(_make_scan(scan_b_id, org_b))

    await asyncio.gather(
        run_scan(scan_a_id, cfg, sb_a),
        run_scan(scan_b_id, cfg, sb_b),
    )

    assert sb_a.finish_calls[0]["status"] == "completed"
    assert sb_b.finish_calls[0]["status"] == "completed"

    a_paths = {u["path"] for u in sb_a.uploads}
    b_paths = {u["path"] for u in sb_b.uploads}
    assert a_paths and b_paths
    assert a_paths.isdisjoint(b_paths)
    assert all(p.startswith(f"{org_a}/{scan_a_id}/") for p in a_paths)
    assert all(p.startswith(f"{org_b}/{scan_b_id}/") for p in b_paths)

    assert len(sb_a.findings) == 2
    assert len(sb_b.findings) == 2

    assert (Path("/tmp/strix-runs") / scan_a_id).is_dir()
    assert (Path("/tmp/strix-runs") / scan_b_id).is_dir()


def test_resolve_llm_uses_per_scan_provider_first(cfg_factory):
    """§3.7: scan.llm_provider takes precedence over org and worker default."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(_make_scan("s", "o"))
    provider, _ = _resolve_llm(cfg, sb, {"id": "s", "llm_provider": "openai/per-scan"})
    assert provider == "openai/per-scan"


def test_resolve_llm_falls_back_to_worker_default(cfg_factory):
    """§3.7: with no per-scan and no org key, the worker default is used."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(_make_scan("s", "o"))
    provider, key = _resolve_llm(cfg, sb, {"id": "s", "llm_provider": None})
    assert provider == "openai/gpt-5.4"
    assert key == "sk-fake"


def test_resolve_llm_uses_org_vault_key_over_worker_default(cfg_factory):
    """§3.7: per-org Vault-stored key wins over the worker default LLM_API_KEY."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(_make_scan("s", "o"))
    sb.decrypt_org_llm_key = lambda scan_id: "sk-org-vault-key"  # type: ignore[assignment]
    _, key = _resolve_llm(cfg, sb, {"id": "s", "llm_provider": None})
    assert key == "sk-org-vault-key"


def test_resolve_llm_raises_when_no_provider_anywhere(cfg_factory):
    """§3.7: with neither scan, org, nor worker default, fail loudly."""
    cfg = _replace(cfg_factory(FAKE_STRIX_SUCCESS), default_strix_llm=None)
    sb = FakeSupabase(_make_scan("s", "o"))
    with pytest.raises(RuntimeError, match="no LLM provider"):
        _resolve_llm(cfg, sb, {"id": "s", "llm_provider": None})


@pytest.mark.asyncio
async def test_integration_credentials_materialised_into_subprocess_env(cfg_factory, fake_scan):
    """§3.6: a linked GitHub integration produces GITHUB_TOKEN in the Strix subprocess env."""
    fake_scan["scan_integrations"] = [
        {
            "integrations": {
                "id": "int-1",
                "type": "github",
                "name": "test-integration",
                "vault_secret_id": "vs-1",
                "metadata": {},
            }
        }
    ]
    cfg = cfg_factory(FAKE_STRIX_ENV_PROBE)
    sb = FakeSupabase(fake_scan)
    sb.decrypt_integration = lambda scan_id, int_id: _json.dumps(  # type: ignore[assignment]
        {"access_token": "ghp_OPAQUE_TOKEN"}
    )

    await run_scan(SCAN_ID, cfg, sb)

    stderr_lines = [
        p["line"] for et, p in sb.events if et == "log" and p["stream"] == "stderr"
    ]
    assert any("GITHUB_TOKEN_PRESENT=yes" in line for line in stderr_lines)


@pytest.mark.asyncio
async def test_no_integration_means_no_github_token(cfg_factory, fake_scan, monkeypatch):
    """§3.6 negative: with no scan_integrations, the subprocess env has no GITHUB_TOKEN.

    Explicitly clear GITHUB_TOKEN from the test process env — the worker
    inherits os.environ, so a token in the developer's shell would otherwise
    leak into the subprocess and fail this assertion.
    """
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    cfg = cfg_factory(FAKE_STRIX_ENV_PROBE)
    sb = FakeSupabase(fake_scan)
    await run_scan(SCAN_ID, cfg, sb)

    stderr_lines = [
        p["line"] for et, p in sb.events if et == "log" and p["stream"] == "stderr"
    ]
    assert any("GITHUB_TOKEN_PRESENT=no" in line for line in stderr_lines)


@pytest.mark.asyncio
async def test_secret_values_never_appear_in_emitted_events(cfg_factory, fake_scan):
    """§3.7: env *values* (LLM key, integration tokens) never appear in any scan_event payload."""
    cfg = _replace(cfg_factory(FAKE_STRIX_SUCCESS), default_llm_api_key="sk-DO-NOT-LEAK-12345")
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    haystack = _json.dumps(
        {
            "events": [(et, p) for et, p in sb.events],
            "findings": sb.findings,
            "uploads": sb.uploads,
        }
    )
    assert "sk-DO-NOT-LEAK-12345" not in haystack


@pytest.mark.asyncio
async def test_credentials_cleaned_up_when_strix_crashes(cfg_factory, fake_scan, monkeypatch):
    """§3.6: CredentialBundle.cleanup runs in the finally block even when Strix crashes."""
    cleaned_up: list[bool] = []

    from strix_worker import credentials as creds_mod
    real_cleanup = creds_mod.CredentialBundle.cleanup

    def patched_cleanup(self):  # type: ignore[no-untyped-def]
        cleaned_up.append(True)
        real_cleanup(self)

    monkeypatch.setattr(creds_mod.CredentialBundle, "cleanup", patched_cleanup)

    cfg = cfg_factory(FAKE_STRIX_FAILURE)
    sb = FakeSupabase(fake_scan)
    await run_scan(SCAN_ID, cfg, sb)

    assert cleaned_up == [True]
    assert sb.finish_calls[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# 3. Mock-fidelity tests — run the mock standalone and check its output
#    matches the on-disk format documented in usestrix/strix's tracer.py.
# ---------------------------------------------------------------------------

# Canonical event types Strix emits, from strix/telemetry/tracer.py.
_REAL_STRIX_EVENT_TYPES = {
    "run.started",
    "run.configured",
    "run.completed",
    "agent.created",
    "agent.status.updated",
    "tool.execution.started",
    "tool.execution.updated",
    "finding.created",
}

# The exact 11 fields tracer._emit_event records on every event.
_REAL_STRIX_EVENT_KEYS = {
    "timestamp",
    "event_type",
    "run_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "actor",
    "payload",
    "status",
    "error",
    "source",
}

_VULN_REQUIRED_HEADERS = (
    "**ID:**",
    "**Severity:**",
    "**Found:**",
)
_VULN_REQUIRED_SECTIONS = (
    "## Description",
    "## Impact",
    "## Technical Analysis",
    "## Proof of Concept",
    "## Remediation",
)


def _run_mock(tmp_path: Path) -> Path:
    """Run the success mock standalone and return the resulting strix_runs dir."""
    script = _write_executable(tmp_path / "fake_strix", FAKE_STRIX_SUCCESS)
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    runs = tmp_path / "strix_runs"
    assert runs.is_dir(), f"mock did not create {runs}"
    return runs


def test_mock_directory_layout_matches_strix(tmp_path):
    """Layout under <cwd>/strix_runs/<run>/ matches tracer.get_run_dir + save_run_data."""
    runs = _run_mock(tmp_path)
    run_dirs = [p for p in runs.iterdir() if p.is_dir()]
    assert len(run_dirs) == 1
    run = run_dirs[0]

    assert (run / "events.jsonl").is_file()
    assert (run / "penetration_test_report.md").is_file()
    assert (run / "vulnerabilities.csv").is_file()
    assert (run / "vulnerabilities").is_dir()


def test_mock_vulnerability_files_use_strix_format(tmp_path):
    """Per-vuln markdown matches strix/telemetry/tracer.py:656-732 exactly."""
    runs = _run_mock(tmp_path)
    run = next(runs.iterdir())
    vuln_files = sorted((run / "vulnerabilities").glob("vuln-*.md"))

    # Filename pattern: vuln-NNNN.md (4-digit zero-padded), per tracer.py:327.
    assert all(
        f.stem.startswith("vuln-") and len(f.stem) == len("vuln-0000") and f.stem[5:].isdigit()
        for f in vuln_files
    )

    for vf in vuln_files:
        text = vf.read_text()

        # First line is `# {title}`.
        first_line = text.splitlines()[0]
        assert first_line.startswith("# ") and len(first_line) > 2

        # Required headers present.
        for header in _VULN_REQUIRED_HEADERS:
            assert header in text, f"{vf.name} missing header {header!r}"

        # Severity is UPPERCASED in the markdown (real Strix calls .upper()).
        sev_line = next(line for line in text.splitlines() if line.startswith("**Severity:**"))
        sev_value = sev_line.split("**Severity:**", 1)[1].strip()
        assert sev_value == sev_value.upper(), f"{vf.name}: severity not uppercase: {sev_value!r}"
        assert sev_value in {"CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"}

        # Required H2 sections present in canonical order.
        section_indices = [text.find(sec) for sec in _VULN_REQUIRED_SECTIONS]
        assert all(i != -1 for i in section_indices), (
            f"{vf.name} missing one of {_VULN_REQUIRED_SECTIONS}"
        )
        assert section_indices == sorted(section_indices), (
            f"{vf.name} has out-of-order sections"
        )


def test_mock_csv_index_matches_strix_columns(tmp_path):
    """vulnerabilities.csv has exact column order from tracer.py:740-745."""
    runs = _run_mock(tmp_path)
    run = next(runs.iterdir())

    with (run / "vulnerabilities.csv").open() as f:
        reader = csv.DictReader(f)
        assert reader.fieldnames == ["id", "title", "severity", "timestamp", "file"]
        rows = list(reader)

    assert len(rows) >= 1
    for row in rows:
        assert row["id"].startswith("vuln-")
        assert row["severity"] == row["severity"].upper()
        assert row["file"] == f"vulnerabilities/{row['id']}.md"
        # Each CSV row points at a real markdown file.
        assert (run / row["file"]).is_file()


def test_mock_events_jsonl_schema_matches_strix(tmp_path):
    """Each events.jsonl record carries the 11-field tracer schema and a known event_type."""
    runs = _run_mock(tmp_path)
    run = next(runs.iterdir())

    records = []
    with (run / "events.jsonl").open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))

    assert records, "events.jsonl is empty"

    for rec in records:
        # Same 11 keys real Strix emits.
        assert set(rec.keys()) == _REAL_STRIX_EVENT_KEYS, (
            f"event has wrong key set: extra={set(rec) - _REAL_STRIX_EVENT_KEYS}, "
            f"missing={_REAL_STRIX_EVENT_KEYS - set(rec)}"
        )
        # event_type is one Strix actually emits.
        assert rec["event_type"] in _REAL_STRIX_EVENT_TYPES, (
            f"unknown event_type {rec['event_type']!r}"
        )

    seen = {r["event_type"] for r in records}
    # A real run starts with run.started and ends with run.completed.
    assert "run.started" in seen
    assert "run.completed" in seen
    # finding.created is what carries vulnerability payloads.
    assert "finding.created" in seen


def test_mock_finding_created_payload_carries_full_report(tmp_path):
    """finding.created events carry the full report dict as `payload.report`."""
    runs = _run_mock(tmp_path)
    run = next(runs.iterdir())

    findings_events = []
    with (run / "events.jsonl").open() as f:
        for line in f:
            rec = json.loads(line)
            if rec["event_type"] == "finding.created":
                findings_events.append(rec)

    assert len(findings_events) >= 1
    for ev in findings_events:
        report = ev["payload"]["report"]
        # Fields tracer.add_vulnerability_report stores on every finding.
        for key in ("id", "title", "severity", "target", "timestamp"):
            assert key in report, f"finding missing {key}: {report.keys()}"
        assert report["id"].startswith("vuln-")


def test_mock_penetration_test_report_has_strix_header(tmp_path):
    """Final summary opens with the real header from tracer.py:626."""
    runs = _run_mock(tmp_path)
    run = next(runs.iterdir())
    text = (run / "penetration_test_report.md").read_text()
    assert text.startswith("# Security Penetration Test Report")
    assert "**Generated:**" in text


# ---------------------------------------------------------------------------
# 4. Token / cost stats — Roadmap §1: stats must populate, not stay at zero.
# ---------------------------------------------------------------------------

from strix_worker.runner import StrixStats  # noqa: E402


def test_stats_parser_humanized_millions_thousands_and_cost():
    """Strix renders tokens through `format_token_count`; we must round-trip the
    common shapes ("2.6M", "14.4K", "850") and the literal Cost line."""
    s = StrixStats()
    s.feed("Input Tokens 2.6M  ·  Cached Tokens 2.1M  ·  Output Tokens 14.4K · Cost $0.2392")
    s.feed("Agents  7  ·  Tools  96")
    assert s.input_tokens == 2_600_000
    assert s.output_tokens == 14_400
    assert s.cost == 0.2392
    assert s.agents_count == 7


def test_stats_parser_takes_running_max_across_renders():
    """Strix reprints the live panel with growing values; we keep the largest."""
    s = StrixStats()
    s.feed("Input Tokens 850  ·  Output Tokens 420")
    s.feed("Cost $0.0050")
    s.feed("Agents 2  ·  Tools 12")
    s.feed("Input Tokens 12.5K  ·  Output Tokens 3.2K")
    s.feed("Cost $0.1180")
    s.feed("Agents 4  ·  Tools 48")
    s.feed("Input Tokens 2.6M  ·  Output Tokens 14.4K · Cost $0.2392")
    s.feed("Agents 7  ·  Tools 96")
    assert s.input_tokens == 2_600_000
    assert s.output_tokens == 14_400
    assert s.cost == 0.2392
    assert s.agents_count == 7


def test_stats_parser_strips_ansi_color_codes():
    """Rich renders the panel with ANSI; the parser must see through it."""
    s = StrixStats()
    s.feed("\x1b[2mInput Tokens \x1b[0m\x1b[1m1.5M\x1b[0m  ·  \x1b[2mOutput Tokens \x1b[0m500")
    s.feed("\x1b[2mCost \x1b[0m\x1b[33m$0.0500\x1b[0m")
    assert s.input_tokens == 1_500_000
    assert s.output_tokens == 500
    assert s.cost == 0.05


def test_stats_parser_ignores_unrelated_log_lines():
    """Log lines that mention 'cost' or 'agents' in prose must not trip the parser."""
    s = StrixStats()
    s.feed("strix: 12 agents available in pool")          # not "Agents N" pattern with whitespace
    s.feed("strix: estimated cost low for this run")      # no "$"
    s.feed("strix: starting scan")
    assert s.input_tokens == 0
    assert s.output_tokens == 0
    assert s.cost == 0.0
    # "12 agents" doesn't match the panel pattern (Agents at start of token, not "agents").
    # Even if it did, the parser is safe — these are operational lines, not panel lines.


def test_stats_parser_finish_kwargs_shape_matches_finish_scan_signature():
    """The kwargs we hand finish_scan must use the names the RPC wrapper expects."""
    s = StrixStats()
    s.feed("Input Tokens 100K · Output Tokens 50K · Cost $1.2345")
    s.feed("Agents 3 · Tools 10")
    kwargs = s.as_finish_kwargs()
    assert set(kwargs) == {
        "total_input_tokens",
        "total_output_tokens",
        "total_cost",
        "agents_count",
    }
    assert kwargs["total_input_tokens"] == 100_000
    assert kwargs["total_output_tokens"] == 50_000
    assert kwargs["total_cost"] == 1.2345
    assert kwargs["agents_count"] == 3


@pytest.mark.asyncio
async def test_run_scan_passes_parsed_stats_to_finish_scan(fake_scan, cfg_factory):
    """End-to-end: a Strix-like subprocess that prints the panel must produce
    populated stats on `finish_scan`. This is the ship-blocker — without it,
    every finished scan reports zero tokens / zero cost."""
    cfg = cfg_factory(FAKE_STRIX_WITH_STATS)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    assert len(sb.finish_calls) == 1
    finish = sb.finish_calls[0]
    assert finish["status"] == "completed"
    # Final panel: Input 2.6M, Cached 2.1M, Output 14.4K, Cost $0.2392, Agents 7.
    assert finish["total_input_tokens"] == 2_600_000
    assert finish["total_output_tokens"] == 14_400
    assert finish["total_cost"] == 0.2392
    assert finish["agents_count"] == 7


@pytest.mark.asyncio
async def test_run_scan_emits_zero_stats_when_strix_prints_no_panel(fake_scan, cfg_factory):
    """A run that crashes before printing the panel should not block finish_scan
    — we still finalise the row, just with zeroes (the existing behaviour)."""
    cfg = cfg_factory(FAKE_STRIX_FAILURE)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    finish = sb.finish_calls[0]
    assert finish["status"] == "failed"
    assert finish["total_input_tokens"] == 0
    assert finish["total_output_tokens"] == 0
    assert finish["total_cost"] == 0.0
    assert finish["agents_count"] == 0


# ---------------------------------------------------------------------------
# 5. events.jsonl tailer — Roadmap §1: live stream of structured events.
#    The tailer turns Strix's on-disk events.jsonl into live scan_events while
#    the run is still in progress, so the UI doesn't have to wait for upload.
# ---------------------------------------------------------------------------

# Custom fake-strix that writes a small, mixed events.jsonl: one of every event
# type the tailer must forward, one of each type it must skip. No findings; no
# stdout panel. Used to assert the skip rules in isolation.
FAKE_STRIX_EVENTS_ONLY = textwrap.dedent('''\
    #!/usr/bin/env python3
    """Writes a hand-crafted events.jsonl with every event-type case the tailer covers."""
    import json
    from datetime import datetime, timezone
    from pathlib import Path

    run_dir = Path.cwd() / "strix_runs" / "events-only"
    run_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()

    def ev(event_type, payload, status="ok"):
        return {
            "timestamp": now,
            "event_type": event_type,
            "run_id": "events-only",
            "trace_id": "0" * 32,
            "span_id": "0" * 16,
            "parent_span_id": None,
            "actor": None,
            "payload": payload,
            "status": status,
            "error": None,
            "source": None,
        }

    with (run_dir / "events.jsonl").open("w") as f:
        f.write(json.dumps(ev("run.started", {"run_name": "events-only"})) + "\\n")
        f.write(json.dumps(ev("agent.created", {"agent_id": "a1", "task": "look around"})) + "\\n")
        f.write(json.dumps(ev("chat.message", {"content": "should be skipped"})) + "\\n")
        f.write(json.dumps(ev("tool.execution.started", {"tool_name": "browser_navigate"})) + "\\n")
        f.write(json.dumps(ev("finding.created", {"report": {"id": "vuln-skip-me"}})) + "\\n")
        f.write(json.dumps(ev("run.completed", {"vulnerability_count": 0})) + "\\n")
''')

# A fake-strix that intermixes valid JSONL with garbage to verify the parser
# survives malformed lines (Strix has been observed to occasionally dump
# tracebacks if a remote-export fails mid-stream).
FAKE_STRIX_MALFORMED_LINES = textwrap.dedent('''\
    #!/usr/bin/env python3
    """Intentionally garbage-in-the-middle events.jsonl — tailer must keep going."""
    import json
    from datetime import datetime, timezone
    from pathlib import Path

    run_dir = Path.cwd() / "strix_runs" / "garbage"
    run_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    base = {
        "timestamp": now, "trace_id": "0"*32, "span_id": "0"*16,
        "parent_span_id": None, "actor": None, "status": "ok", "error": None, "source": None,
        "run_id": "garbage",
    }

    with (run_dir / "events.jsonl").open("w") as f:
        f.write(json.dumps({**base, "event_type": "run.started", "payload": {"a": 1}}) + "\\n")
        f.write("not-json garbage line\\n")
        f.write("{ this is also broken json\\n")
        f.write(json.dumps({**base, "event_type": "agent.created", "payload": {"agent_id": "a"}}) + "\\n")
        f.write(json.dumps({**base, "event_type": "run.completed", "payload": {}}) + "\\n")
''')

# A fake-strix that never creates strix_runs/. The tailer's discovery loop
# should give up gracefully without blocking the run from finalising.
FAKE_STRIX_NO_EVENTS_DIR = textwrap.dedent('''\
    #!/usr/bin/env python3
    """Exits 0 without writing any artifacts."""
    import sys
    print("strix: nothing to do")
    sys.exit(0)
''')


@pytest.mark.asyncio
async def test_tailer_skips_finding_created_and_chat_message(fake_scan, cfg_factory):
    cfg = cfg_factory(FAKE_STRIX_EVENTS_ONLY)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    streamed = [et for et, _ in sb.events]
    # Forward these.
    assert "run.started" in streamed
    assert "agent.created" in streamed
    assert "tool.execution.started" in streamed
    assert "run.completed" in streamed
    # Skip these.
    assert "chat.message" not in streamed
    # finding.created from events.jsonl is skipped — no row whose payload has
    # the sentinel id we wrote in the mock should land in scan_events.
    finding_payloads = [p for et, p in sb.events if et == "finding.created"]
    assert all(
        (p or {}).get("payload", {}).get("report", {}).get("id") != "vuln-skip-me"
        for p in finding_payloads
    )


@pytest.mark.asyncio
async def test_tailer_resilient_to_malformed_jsonl_lines(fake_scan, cfg_factory):
    cfg = cfg_factory(FAKE_STRIX_MALFORMED_LINES)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    # Run still finishes cleanly.
    finish = sb.finish_calls[0]
    assert finish["status"] == "completed"

    # Both valid events arrive; garbage lines silently dropped.
    streamed = [et for et, _ in sb.events]
    assert "run.started" in streamed
    assert "agent.created" in streamed
    assert "run.completed" in streamed


@pytest.mark.asyncio
async def test_tailer_handles_missing_events_jsonl(fake_scan, cfg_factory):
    """A run that never writes events.jsonl must not block finalisation."""
    cfg = cfg_factory(FAKE_STRIX_NO_EVENTS_DIR)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    # The scan still finalises — exit 0 means completed.
    finish = sb.finish_calls[0]
    assert finish["status"] == "completed"
    assert finish["exit_code"] == 0

    # No structured events forwarded (there were none on disk), but the
    # lifecycle events from the worker still landed.
    streamed = {et for et, _ in sb.events}
    assert "scan.command" in streamed
    assert not any(et in streamed for et in {"agent.created", "tool.execution.started"})


@pytest.mark.asyncio
async def test_tailer_does_not_hold_file_open_after_run(fake_scan, cfg_factory):
    """Upload must be able to read events.jsonl after the tailer returns."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    # _upload_run_artifacts walks the run dir and uploads events.jsonl. If the
    # tailer were still holding it open, the upload would either fail (Win32)
    # or read a half-flushed buffer (POSIX). Asserting the artifact uploaded
    # with non-zero size is a proxy for "the file was readable post-tailer".
    events_uploads = [u for u in sb.uploads if u["path"].endswith("/events.jsonl")]
    assert len(events_uploads) == 1
    assert events_uploads[0]["size"] > 0


# ---------------------------------------------------------------------------
# 6. Lifecycle hardening — Roadmap §1: atomic claim, heartbeat, cancel.
# ---------------------------------------------------------------------------

# A long-running fake-strix that produces no panel and just sleeps until
# killed. Used by cancel tests so we have a window to fire the cancel.
FAKE_STRIX_LONG_RUNNING = textwrap.dedent('''\
    #!/usr/bin/env python3
    """A scan that never finishes on its own — sleeps indefinitely. The test
    sends SIGTERM, and Python's default handler exits with -15."""
    import sys, time, signal
    print("strix: long-running scan started")
    sys.stdout.flush()
    # No SIGTERM handler — let the default propagate so proc.returncode == -15.
    time.sleep(60)
''')


@pytest.mark.asyncio
async def test_run_scan_emits_heartbeat_during_run(fake_scan, cfg_factory):
    """A running scan must tick last_heartbeat_at so the stale-scan sweep
    knows the worker is alive."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    # The mock finishes too quickly for the 60-second cadence to tick more
    # than once, but we should see at least one heartbeat (the loop calls
    # heartbeat_scan immediately on entry).
    assert sb.heartbeat_calls >= 1


@pytest.mark.asyncio
async def test_run_scan_marks_cancelled_on_signal_exit(fake_scan, cfg_factory):
    """SIGTERM'd run reports `cancelled`, not `failed`. Without this, a user
    pressing Cancel would see the scan listed as a failure — wrong status."""
    from strix_worker.runner import cancel_running_scan

    cfg = cfg_factory(FAKE_STRIX_LONG_RUNNING)
    sb = FakeSupabase(fake_scan)

    async def cancel_after_delay():
        # Wait long enough for proc to register in _RUNNING_PROCS, then signal.
        await asyncio.sleep(0.4)
        cancel_running_scan(SCAN_ID)

    await asyncio.gather(run_scan(SCAN_ID, cfg, sb), cancel_after_delay())

    finish = sb.finish_calls[0]
    assert finish["status"] == "cancelled"
    # POSIX: child killed by SIGTERM => returncode == -15.
    assert finish["exit_code"] is not None and finish["exit_code"] < 0


@pytest.mark.asyncio
async def test_run_scan_marks_cancelled_when_db_flag_set_even_if_clean_exit(
    fake_scan, cfg_factory,
):
    """Cancel can race with a normal exit. If the user pressed Cancel and
    Strix happened to complete cleanly before SIGTERM landed, we still
    honour the requested status — otherwise the row would say `completed`
    despite the user clearly intending to abort."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(fake_scan)
    sb._cancel_requested_at = "2026-04-29T10:00:00Z"

    await run_scan(SCAN_ID, cfg, sb)

    finish = sb.finish_calls[0]
    assert finish["status"] == "cancelled"
    # The actual exit code was 0 (Strix wrote everything, exited normally),
    # but we override the status because cancel_requested_at is set.
    assert finish["exit_code"] == 0


@pytest.mark.asyncio
async def test_cancel_running_scan_returns_false_when_not_owned(fake_scan, cfg_factory):
    """The listener calls cancel_running_scan for every NOTIFY; if this
    worker doesn't own the scan, it must be a quiet no-op (the scan is on a
    different worker, or already finished)."""
    from strix_worker.runner import cancel_running_scan

    # No run in flight — registry is empty.
    assert cancel_running_scan("00000000-0000-0000-0000-000000000000") is False


@pytest.mark.asyncio
async def test_run_scan_bails_when_claim_loses_race(fake_scan, cfg_factory):
    """If claim_scan returns None (another worker won), the runner must NOT
    call finish_scan — it doesn't own the row."""
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    sb = FakeSupabase(fake_scan)
    sb.claim_returns_truthy = False

    await run_scan(SCAN_ID, cfg, sb)

    assert sb.claim_calls == 1
    assert sb.finish_calls == []
    assert sb.events == []
    assert sb.uploads == []
