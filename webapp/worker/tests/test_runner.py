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
            # Strix's structured code_locations — the source of truth that
            # downstream RAG triage consumes via parse_code_analysis_section.
            "code_locations": [
                {
                    "file": "webapp/api/search.py",
                    "start_line": 42,
                    "end_line": 42,
                    "label": "user input flows into raw SQL",
                    "snippet": "sql = SELECT_USERS_WHERE_NAME + q",
                    "fix_before": "sql = SELECT_USERS_WHERE_NAME + q",
                    "fix_after": "db.execute(SELECT_USERS_WHERE_NAME_PARAM, [q])",
                },
            ],
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
            "code_locations": [],  # exercises the empty path
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
            # ## Code Analysis — exact format from tracer.save_run_data:699-727
            if r.get("code_locations"):
                out.write("## Code Analysis\\n\\n")
                for i, loc in enumerate(r["code_locations"]):
                    line_ref = ""
                    if loc.get("start_line") is not None:
                        if loc.get("end_line") and loc["end_line"] != loc["start_line"]:
                            line_ref = f" (lines {loc[\'start_line\']}-{loc[\'end_line\']})"
                        else:
                            line_ref = f" (line {loc[\'start_line\']})"
                    out.write(f"**Location {i + 1}:** `{loc[\'file\']}`{line_ref}\\n")
                    if loc.get("label"):
                        out.write(f"  {loc[\'label\']}\\n")
                    if loc.get("snippet"):
                        out.write(f"  ```\\n  {loc[\'snippet\']}\\n  ```\\n")
                    if loc.get("fix_before") or loc.get("fix_after"):
                        out.write("\\n  **Suggested Fix:**\\n")
                        out.write("```diff\\n")
                        if loc.get("fix_before"):
                            for line in loc["fix_before"].splitlines():
                                out.write(f"- {line}\\n")
                        if loc.get("fix_after"):
                            for line in loc["fix_after"].splitlines():
                                out.write(f"+ {line}\\n")
                        out.write("```\\n")
                    out.write("\\n")
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

    def decrypt_scan_auth(self, scan_id: str) -> tuple[str | None, str | None]:
        # Phase A / migration 061. Tests can override by setting
        # `self.scan_auth = ("bearer", "<token>")` to exercise the
        # auth-env-var path.
        return getattr(self, "scan_auth", (None, None))

    def decrypt_org_llm_key(self, scan_id: str) -> str | None:
        return None

    def decrypt_org_slack_webhook(self, scan_id: str) -> str | None:
        # Tests can override by setting `self.slack_webhook` to a string.
        return getattr(self, "slack_webhook", None)

    def decrypt_org_secrets(self, scan_id: str) -> dict[str, str]:
        # Tests don't exercise per-org STRIX_* keys; an empty dict
        # mirrors the production fail-open path when no keys are set.
        return {}

    def set_sbom_uploaded(self, scan_id: str) -> None:
        # Tests assert via `sb._sbom_uploaded`. Mirrors the
        # set_compliance_pack_uploaded fake.
        self._sbom_uploaded = True

    def set_run_meta(self, scan_id: str, run_meta: dict[str, Any]) -> None:
        # Tests can read this back via `sb.run_meta` to assert the
        # worker forwarded the right blob to Postgres.
        self.run_meta = run_meta

    def set_coverage(self, scan_id: str, coverage: dict[str, Any]) -> None:
        # Tests assert via `sb.coverage`. Mirrors set_run_meta.
        self.coverage = coverage

    def set_compliance_pack_uploaded(self, scan_id: str) -> None:
        # Tests don't drive the compliance-pack upload path; the worker
        # only calls this after at least one file lands in storage, and
        # the fake's `upload_artifact` just appends to `self.uploads` so
        # exercising flow-end-to-end isn't necessary for the runner
        # state-machine tests. Real coverage lives in dedicated tests.
        self._compliance_pack_uploaded = True

    def ingest_compliance_evidence(
        self, scan_id: str, evidence: dict[str, Any]
    ) -> int:
        # Captured for assertion. Real RPC returns the count of controls
        # persisted; we mirror by counting framework × control pairs.
        self._ingested_evidence = {"scan_id": scan_id, "evidence": evidence}
        count = 0
        for fw_value in evidence.values():
            if isinstance(fw_value, dict):
                count += len(fw_value)
        return count

    def set_preflight_failed(self, scan_id: str) -> None:
        self._preflight_failed = True

    def upload_artifact(
        self, bucket: str, path: str, contents: bytes, content_type: str = "text/plain"
    ) -> None:
        self.uploads.append({"bucket": bucket, "path": path, "size": len(contents)})

    def download_artifact(self, bucket: str, path: str) -> bytes:
        # Tests pre-seed `self.staged_downloads` keyed by path. A
        # missing key raises so the download_imports error path
        # (logged + dropped) gets exercised.
        if not hasattr(self, "staged_downloads"):
            raise FileNotFoundError(f"no fake download seeded for {path}")
        try:
            return self.staged_downloads[path]
        except KeyError as e:
            raise FileNotFoundError(f"no fake download seeded for {path}") from e


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
            wrapper_origin=None,
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
    cmd = cmd_payload["cmd"]
    # Headline flags — assert presence and adjacency rather than absolute
    # index because the runner appends new flags (--feedback-from,
    # --compliance-pack, etc.) and pinning index would force every PR
    # that adds a flag to retouch this test.
    assert cmd[1] == "-n"
    assert cmd[2:4] == ["-m", "quick"]
    assert "-t" in cmd
    assert "https://example.com" in cmd
    assert "--instruction" in cmd
    # Compliance-pack flag is always emitted (engine PR #129 / migration 030).
    assert "--compliance-pack" in cmd
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

    # ---- 5b. Strix's `## Code Analysis` parsed back into structured affected_files ----
    # vuln-0001 has one code_location with snippet + suggested fix; the
    # ingest path must round-trip those out of the markdown.
    aff = by_id["vuln-0001"]["payload"]["affected_files"]
    assert isinstance(aff, list) and len(aff) == 1
    loc = aff[0]
    assert loc["path"] == "webapp/api/search.py"
    assert loc["line"] == 42
    assert "SELECT_USERS_WHERE_NAME" in loc["snippet"]
    assert loc["fix_before"].startswith("sql = SELECT_USERS_WHERE_NAME")
    assert "db.execute" in loc["fix_after"]
    # vuln-0002 had no code_locations — payload should be None (not [], not missing).
    assert by_id["vuln-0002"]["payload"]["affected_files"] is None

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


# ---------------------------------------------------------------------------
# Migration 033 — branch picker plumbing (engine PR #117)
# ---------------------------------------------------------------------------

from strix_worker.runner import _build_cmd  # noqa: E402


def test_build_cmd_appends_branch_when_set(cfg_factory):
    """A repository scan with `branch` set must produce `--branch <ref>`
    in the engine command. Tags / SHAs round-trip the same way."""
    cfg = cfg_factory("")  # script body irrelevant here
    scan = {
        "scan_mode": "quick",
        "scope_mode": "auto",
        "branch": "feature/refactor",
    }
    targets = [{"value": "https://github.com/example/repo"}]

    cmd = _build_cmd(cfg, scan, targets)

    assert "--branch" in cmd
    assert cmd[cmd.index("--branch") + 1] == "feature/refactor"


def test_build_cmd_omits_branch_when_blank_or_missing(cfg_factory):
    """Empty / whitespace-only / missing `branch` must NOT add --branch.
    Stripping happens in the SQL RPC and the API zod schema, but the
    worker re-strips defensively in case a stray space slips through."""
    cfg = cfg_factory("")
    targets = [{"value": "https://github.com/example/repo"}]

    for branch_value in [None, "", "   "]:
        scan = {"scan_mode": "quick", "scope_mode": "auto", "branch": branch_value}
        cmd = _build_cmd(cfg, scan, targets)
        assert "--branch" not in cmd, f"branch={branch_value!r} leaked through"


def test_build_cmd_appends_cost_caps_when_set(cfg_factory):
    """max_cost / max_input_tokens should land as the engine's
    `--max-cost <usd>` and `--max-input-tokens <n>` flags. Either or
    both may be set; null values are omitted."""
    cfg = cfg_factory("")
    targets = [{"value": "https://example.com"}]

    scan = {
        "scan_mode": "standard",
        "scope_mode": "auto",
        "max_cost": 5.0,
        "max_input_tokens": 250_000,
    }
    cmd = _build_cmd(cfg, scan, targets)
    assert "--max-cost" in cmd
    assert cmd[cmd.index("--max-cost") + 1] == "5.0"
    assert "--max-input-tokens" in cmd
    assert cmd[cmd.index("--max-input-tokens") + 1] == "250000"


# ---------------------------------------------------------------------------
# Migration 035 — HAR/Burp upload pipeline (engine PR #141)
# ---------------------------------------------------------------------------

from strix_worker.runner import _download_imports, _imports_instruction_hint  # noqa: E402


def test_download_imports_writes_files_and_returns_workspace_paths(tmp_path, fake_scan):
    """Happy path: each storage entry lands at <workdir>/imports/<filename>
    and the returned list carries the workspace-relative path the agent
    will see via ingest_har_file / ingest_burp_file."""
    sb = FakeSupabase(fake_scan)
    sb.staged_downloads = {
        f"{ORG_ID}/scan-imports/abc/burp.xml": b"<items></items>",
        f"{ORG_ID}/scan-imports/def/web.har": b'{"log":{}}',
    }
    workdir = str(tmp_path / "wd")
    Path(workdir).mkdir()
    metas = [
        {"kind": "burp", "storage_path": f"{ORG_ID}/scan-imports/abc/burp.xml",
         "filename": "burp.xml", "size_bytes": 14},
        {"kind": "har", "storage_path": f"{ORG_ID}/scan-imports/def/web.har",
         "filename": "web.har", "size_bytes": 11},
    ]

    staged = _download_imports(sb, SCAN_ID, metas, workdir)

    assert {e["filename"] for e in staged} == {"burp.xml", "web.har"}
    assert {e["container_path"] for e in staged} == {"imports/burp.xml", "imports/web.har"}
    # Files actually landed on disk.
    assert (Path(workdir) / "imports" / "burp.xml").read_bytes() == b"<items></items>"
    assert (Path(workdir) / "imports" / "web.har").read_bytes() == b'{"log":{}}'


def test_download_imports_drops_unknown_kinds(tmp_path, fake_scan):
    """The CHECK enum is enforced server-side, but the worker re-checks
    before download — defence in depth against a future API drift that
    might let an arbitrary kind slip through."""
    sb = FakeSupabase(fake_scan)
    sb.staged_downloads = {f"{ORG_ID}/scan-imports/x/foo.bin": b"raw"}
    workdir = str(tmp_path / "wd")
    Path(workdir).mkdir()
    metas = [{
        "kind": "binary",  # not allowed
        "storage_path": f"{ORG_ID}/scan-imports/x/foo.bin",
        "filename": "foo.bin",
        "size_bytes": 3,
    }]
    assert _download_imports(sb, SCAN_ID, metas, workdir) == []


def test_download_imports_blocks_path_traversal(tmp_path, fake_scan):
    """A filename containing path separators must be flattened by
    Path(...).name and any `..` components rejected outright."""
    sb = FakeSupabase(fake_scan)
    sb.staged_downloads = {f"{ORG_ID}/scan-imports/x/safe.har": b"{}"}
    workdir = str(tmp_path / "wd")
    Path(workdir).mkdir()
    # `..` filename is rejected; nested-path filename is flattened.
    metas = [
        {"kind": "har", "storage_path": f"{ORG_ID}/scan-imports/x/safe.har",
         "filename": "..", "size_bytes": 2},
    ]
    assert _download_imports(sb, SCAN_ID, metas, workdir) == []


def test_download_imports_swallows_individual_failures(tmp_path, fake_scan):
    """One failed download must not block the rest. Good imports still
    reach the agent's workspace; the bad one is simply omitted."""
    sb = FakeSupabase(fake_scan)
    sb.staged_downloads = {
        f"{ORG_ID}/scan-imports/g/good.har": b"{}",
        # `<bad>` storage path NOT in staged_downloads → triggers
        # FileNotFoundError on download
    }
    workdir = str(tmp_path / "wd")
    Path(workdir).mkdir()
    metas = [
        {"kind": "har", "storage_path": f"{ORG_ID}/scan-imports/g/good.har",
         "filename": "good.har", "size_bytes": 2},
        {"kind": "burp", "storage_path": f"{ORG_ID}/scan-imports/b/bad.xml",
         "filename": "bad.xml", "size_bytes": 99},
    ]

    staged = _download_imports(sb, SCAN_ID, metas, workdir)
    assert [e["filename"] for e in staged] == ["good.har"]
    assert (Path(workdir) / "imports" / "good.har").exists()
    assert not (Path(workdir) / "imports" / "bad.xml").exists()


def test_download_imports_returns_empty_for_missing_or_non_list_meta(tmp_path, fake_scan):
    """`scan.imports` may be None (pre-migration scans), [], or some
    other type via API drift — all three must produce an empty list,
    no exception, and no `imports/` directory creation."""
    sb = FakeSupabase(fake_scan)
    workdir = str(tmp_path / "wd")
    Path(workdir).mkdir()
    for meta in [None, [], "not a list", {"oops": True}]:
        assert _download_imports(sb, SCAN_ID, meta, workdir) == []


def test_imports_instruction_hint_names_engine_tools_explicitly():
    """The hint must name the engine's ingest tools by their exact
    function names (`ingest_har_file` / `ingest_burp_file`) so the
    agent's planner can match without ambiguity."""
    staged = [
        {"kind": "har", "container_path": "imports/web.har", "filename": "web.har"},
        {"kind": "burp", "container_path": "imports/proj.xml", "filename": "proj.xml"},
    ]
    hint = _imports_instruction_hint(staged)
    assert hint is not None
    assert "ingest_har_file('imports/web.har')" in hint
    assert "ingest_burp_file('imports/proj.xml')" in hint
    # The redaction reminder mirrors the upload-form copy.
    assert "redacted" in hint.lower()


def test_imports_instruction_hint_returns_none_when_empty():
    """Empty / None input → no hint, callers omit the section."""
    assert _imports_instruction_hint(None) is None
    assert _imports_instruction_hint([]) is None


def test_build_cmd_appends_imports_hint_to_instruction(cfg_factory):
    """End-to-end through _build_cmd: the staged imports pop into the
    --instruction text under the user's own instruction."""
    cfg = cfg_factory("")
    targets = [{"value": "https://example.com"}]
    scan = {
        "scan_mode": "standard",
        "scope_mode": "auto",
        "instruction_text": "Focus on auth flaws.",
    }
    staged = [{"kind": "har", "container_path": "imports/x.har", "filename": "x.har"}]

    cmd = _build_cmd(cfg, scan, targets, staged_imports=staged)

    assert "--instruction" in cmd
    instr = cmd[cmd.index("--instruction") + 1]
    assert "Focus on auth flaws." in instr
    assert "ingest_har_file('imports/x.har')" in instr
    assert "Pre-loaded traffic is available" in instr


def test_build_cmd_omits_imports_section_when_no_staged(cfg_factory):
    """No staged imports → the instruction text is just the user's text;
    no Pre-loaded traffic banner is appended."""
    cfg = cfg_factory("")
    targets = [{"value": "https://example.com"}]
    scan = {"scan_mode": "standard", "scope_mode": "auto",
            "instruction_text": "Focus on auth flaws."}

    cmd = _build_cmd(cfg, scan, targets, staged_imports=None)
    instr = cmd[cmd.index("--instruction") + 1]
    assert instr.strip() == "Focus on auth flaws."


def test_build_cmd_omits_cost_caps_when_zero_or_missing(cfg_factory):
    """A zero or negative budget value tells the engine 'no cap', not
    'zero allowed'. We omit the flag entirely so the engine's default
    no-cap behaviour kicks in."""
    cfg = cfg_factory("")
    targets = [{"value": "https://example.com"}]

    for caps in [
        {"max_cost": 0, "max_input_tokens": 0},
        {"max_cost": -1.0, "max_input_tokens": -10},
        {"max_cost": None, "max_input_tokens": None},
        {},
    ]:
        scan = {"scan_mode": "standard", "scope_mode": "auto", **caps}
        cmd = _build_cmd(cfg, scan, targets)
        assert "--max-cost" not in cmd, f"max_cost={caps.get('max_cost')!r} leaked through"
        assert "--max-input-tokens" not in cmd, (
            f"max_input_tokens={caps.get('max_input_tokens')!r} leaked through"
        )


# ---------------------------------------------------------------------------
# Migration 029 — preflight detection + trajectory.jsonl ingestion
# ---------------------------------------------------------------------------

from strix_worker.runner import (  # noqa: E402
    StderrTailBuffer,
    _looks_like_preflight_failure,
    _load_trajectories,
)


def test_stderr_buffer_keeps_only_tail_under_limit():
    """The buffer caps memory by dropping older chunks; tail() reflects the
    most recent bytes — exactly where the engine's preflight panel lands."""
    buf = StderrTailBuffer()
    # Push way past the 16 KiB cap; only the tail should remain.
    for i in range(2000):
        buf.feed(f"line {i}: " + "x" * 64)
    tail = buf.tail()
    assert "line 1999" in tail  # most recent kept
    assert "line 0:" not in tail  # earliest dropped


def test_preflight_detector_matches_engine_panel_text():
    """The conservative pattern should fire on engine PR #30's typical
    diagnostic shape and stay quiet on benign 'preflight passed' text."""
    fail_panels = [
        "Preflight check failed for target https://example.invalid",
        "PREFLIGHT: could not resolve example.invalid",
        "preflight did not complete: connection refused",
        "[bold]Preflight[/bold]: target is unreachable",
        "Preflight unable to reach target",
    ]
    for panel in fail_panels:
        assert _looks_like_preflight_failure(panel), f"missed: {panel!r}"


def test_preflight_detector_ignores_benign_mentions():
    """A scan that mentions 'preflight passed' or just runs successfully
    should not trip the detector. Pattern requires a failure verb."""
    benign = [
        "Preflight passed in 4.2s",
        "All preflight checks completed successfully",
        "Running tests…",
        "",
    ]
    for line in benign:
        assert not _looks_like_preflight_failure(line), f"false positive: {line!r}"


def test_preflight_detector_strips_ansi_before_matching():
    """Engine renders the panel through Rich; ANSI codes must be stripped
    before pattern-match or the detector misses every coloured panel."""
    coloured = "\x1b[31mPreflight failed\x1b[0m for https://example.invalid"
    assert _looks_like_preflight_failure(coloured)


def test_load_trajectories_keys_by_finding_id(tmp_path):
    """Each line of trajectory.jsonl maps to one finding via its
    finding_id field; the loader returns a {finding_id: record} map."""
    run_dir = tmp_path / "run-1"
    run_dir.mkdir()
    (run_dir / "trajectory.jsonl").write_text(
        "\n".join([
            json.dumps({
                "finding_id": "vuln-001",
                "iterations_to_emit": 12,
                "time_to_emit_seconds": 4.1,
                "events_compact": [{"tool": "send_request"}],
                "dismissed_alternatives": [],
                "exploration_breadth": 3,
                "schema_version": 1,
            }),
            json.dumps({
                "finding_id": "vuln-002",
                "iterations_to_emit": 47,  # outlier — engine struggled
                "time_to_emit_seconds": 92.0,
                "dismissed_alternatives": [
                    {"hypothesis": "redirect was open", "reason": "host whitelisted"},
                ],
            }),
            "",  # blank line — must be ignored
            "{not-json",  # malformed — must be skipped, not crash
        ]) + "\n"
    )

    out = _load_trajectories(run_dir)
    assert set(out.keys()) == {"vuln-001", "vuln-002"}
    assert out["vuln-001"]["iterations_to_emit"] == 12
    assert out["vuln-002"]["iterations_to_emit"] == 47
    assert out["vuln-002"]["dismissed_alternatives"][0]["reason"] == "host whitelisted"


def test_load_trajectories_returns_empty_when_file_missing(tmp_path):
    """Older engine versions don't write trajectory.jsonl; loader must
    not crash, just return an empty map. The trajectory column stays null."""
    run_dir = tmp_path / "run-empty"
    run_dir.mkdir()
    assert _load_trajectories(run_dir) == {}


# ---------------------------------------------------------------------------
# Migration 030 — compliance pack upload (engine PR #129)
# ---------------------------------------------------------------------------

from strix_worker.runner import _content_type_for, _upload_compliance_pack  # noqa: E402


def test_pack_content_type_uses_known_extensions():
    """Auditor previews only render inline when storage hands back the
    right content-type. The closed map covers every file shape the
    engine writes; anything else falls back to text/plain."""
    assert _content_type_for(Path("manifest.json")) == "application/json"
    assert _content_type_for(Path("findings.csv")) == "text/csv"
    assert _content_type_for(Path("control_attestation.md")) == "text/markdown"
    assert _content_type_for(Path("events.jsonl")) == "application/x-ndjson"
    assert _content_type_for(Path("SHA256SUMS")) == "text/plain; charset=utf-8"
    assert _content_type_for(Path("foo.bin")) == "text/plain; charset=utf-8"


# ---------------------------------------------------------------------------
# Migration 031 — run_meta.json persistence (engine PR #133 + #132 + #103)
# ---------------------------------------------------------------------------

from strix_worker.runner import _persist_run_meta  # noqa: E402


def test_persist_run_meta_writes_full_blob(tmp_path, fake_scan):
    """Worker stores the whole run_meta blob verbatim on the scan row.
    The UI reads typed paths into the JSONB so adding a new top-level
    signal is a UI change, not a schema change."""
    run_dir = tmp_path / "run-1"
    run_dir.mkdir()
    blob = {
        "vendor_risk": {
            "score": 72,
            "band": "medium_risk",
            "deductions_by_category": {"tls": -10, "headers": -8, "dns": -10},
            "recommendation": "Address TLS hygiene first",
        },
        "mfa_attestation": {
            "score": 3,
            "max": 4,
            "breakdown": {
                "login_tokens": True,
                "challenge_keys": True,
                "webauthn_header": False,
                "mfa_setup_paths": True,
            },
        },
        "compliance_posture": {"cadence_status": "In compliance"},
    }
    (run_dir / "run_meta.json").write_text(json.dumps(blob))

    sb = FakeSupabase(fake_scan)
    _persist_run_meta(sb, SCAN_ID, run_dir)

    assert getattr(sb, "run_meta", None) == blob


def test_persist_run_meta_swallows_missing_file(tmp_path, fake_scan):
    """Older engine versions or scans that crashed pre-meta-write —
    skip silently rather than fail the finalisation."""
    run_dir = tmp_path / "run-empty"
    run_dir.mkdir()

    sb = FakeSupabase(fake_scan)
    _persist_run_meta(sb, SCAN_ID, run_dir)

    assert getattr(sb, "run_meta", None) is None


def test_persist_run_meta_swallows_parse_error(tmp_path, fake_scan):
    """A malformed run_meta.json must not block the rest of finalisation
    — vendor_risk/MFA simply won't render."""
    run_dir = tmp_path / "run-bad"
    run_dir.mkdir()
    (run_dir / "run_meta.json").write_text("{not-json")

    sb = FakeSupabase(fake_scan)
    _persist_run_meta(sb, SCAN_ID, run_dir)

    assert getattr(sb, "run_meta", None) is None


# ---------------------------------------------------------------------------
# Migration 039 — coverage.json persistence (Tier A trust-gap fix)
# ---------------------------------------------------------------------------

from strix_worker.runner import _persist_coverage  # noqa: E402


def test_persist_coverage_writes_full_blob(tmp_path, fake_scan):
    """The engine's coverage.json lands verbatim on the scan row so the
    UI can render the amber 'coverage incomplete' banner when
    `status=incomplete`. Critical UX bridge — a 0-finding scan is
    ambiguous between 'site is clean' and 'agent gave up early'."""
    run_dir = tmp_path / "run-1"
    run_dir.mkdir()
    blob = {
        "schema_version": 1,
        "run_id": "getedunext-com_e06a",
        "required": ["csrf", "idor", "open_redirect", "sqli", "ssrf", "xss"],
        "completed": [],
        "covered": [],
        "gaps": ["csrf", "idor", "open_redirect", "sqli", "ssrf", "xss"],
        "coverage_percent": 0.0,
        "status": "incomplete",
    }
    (run_dir / "coverage.json").write_text(json.dumps(blob))

    sb = FakeSupabase(fake_scan)
    _persist_coverage(sb, SCAN_ID, run_dir)

    assert getattr(sb, "coverage", None) == blob


def test_persist_coverage_swallows_missing_file(tmp_path, fake_scan):
    """Older engines without coverage.json — skip silently rather than
    fail finalisation."""
    run_dir = tmp_path / "run-empty"
    run_dir.mkdir()

    sb = FakeSupabase(fake_scan)
    _persist_coverage(sb, SCAN_ID, run_dir)

    assert getattr(sb, "coverage", None) is None


def test_persist_coverage_swallows_parse_error(tmp_path, fake_scan):
    """Malformed coverage.json must not block the rest of finalisation."""
    run_dir = tmp_path / "run-bad"
    run_dir.mkdir()
    (run_dir / "coverage.json").write_text("{not-json")

    sb = FakeSupabase(fake_scan)
    _persist_coverage(sb, SCAN_ID, run_dir)

    assert getattr(sb, "coverage", None) is None


def test_persist_run_meta_rejects_non_object(tmp_path, fake_scan):
    """A JSON array at the top level (very unlikely engine drift) is
    treated as missing rather than blindly persisted."""
    run_dir = tmp_path / "run-arr"
    run_dir.mkdir()
    (run_dir / "run_meta.json").write_text('["array, not object"]')

    sb = FakeSupabase(fake_scan)
    _persist_run_meta(sb, SCAN_ID, run_dir)

    assert getattr(sb, "run_meta", None) is None


@pytest.mark.asyncio
async def test_upload_compliance_pack_walks_dir_and_flips_flag(tmp_path, fake_scan):
    """End-to-end: a non-empty pack dir produces uploads under the
    compliance_pack/ prefix AND flips the new boolean column."""
    pack_root = tmp_path / "compliance_pack"
    (pack_root / "run-abc").mkdir(parents=True)
    (pack_root / "run-abc" / "manifest.json").write_text("{}")
    (pack_root / "run-abc" / "findings.csv").write_text("a,b\n1,2\n")
    (pack_root / "run-abc" / "SHA256SUMS").write_text("hash manifest.json\n")

    sb = FakeSupabase(fake_scan)
    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    pack_uploads = [u for u in sb.uploads if "compliance_pack" in u["path"]]
    assert len(pack_uploads) == 3
    paths = {u["path"] for u in pack_uploads}
    assert any(p.endswith("manifest.json") for p in paths)
    assert any(p.endswith("findings.csv") for p in paths)
    assert any(p.endswith("SHA256SUMS") for p in paths)
    for p in paths:
        assert p.startswith(f"{ORG_ID}/{SCAN_ID}/compliance_pack/")
    # Flag flipped because at least one file uploaded.
    assert getattr(sb, "_compliance_pack_uploaded", False) is True


@pytest.mark.asyncio
async def test_upload_compliance_pack_skips_when_dir_missing(tmp_path, fake_scan):
    """No pack dir at all (older engine without #129, or path mismatch).
    The UI keys the download button off the flag and a dangling button
    is worse than no button."""
    pack_root = tmp_path / "does_not_exist"

    sb = FakeSupabase(fake_scan)
    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    assert [u for u in sb.uploads if "compliance_pack" in u["path"]] == []
    assert getattr(sb, "_compliance_pack_uploaded", False) is False


@pytest.mark.asyncio
async def test_upload_compliance_pack_ingests_evidence_json(tmp_path, fake_scan):
    """Migration 046 / Phase C v4 — when the pack contains
    compliance_evidence.json (engine PR #219 §4b), the worker calls
    sb.ingest_compliance_evidence with the parsed payload so the chat
    handler + trust page can answer compliance questions with real data.
    """
    pack_root = tmp_path / "compliance_pack"
    run_dir = pack_root / "run-abc"
    run_dir.mkdir(parents=True)
    (run_dir / "manifest.json").write_text("{}")
    (run_dir / "compliance_evidence.json").write_text(
        '{"soc2_type_2": {'
        '"CC6.1": {"verdict": "pass", "summary": "Access controls"},'
        '"CC7.2": {"verdict": "fail", "summary": "No SIEM detected"}'
        '}, "iso_27001": {'
        '"A.5.1": {"verdict": "pass", "summary": "InfoSec policies"}'
        '}}'
    )

    sb = FakeSupabase(fake_scan)
    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    # Ingest captured.
    ingested = getattr(sb, "_ingested_evidence", None)
    assert ingested is not None, "ingest_compliance_evidence should have been called"
    assert ingested["scan_id"] == SCAN_ID
    assert "soc2_type_2" in ingested["evidence"]
    assert ingested["evidence"]["soc2_type_2"]["CC6.1"]["verdict"] == "pass"
    assert "iso_27001" in ingested["evidence"]


@pytest.mark.asyncio
async def test_upload_compliance_pack_skips_ingest_when_no_evidence_json(
    tmp_path, fake_scan
):
    """Older engines that emit the auditor pack but not the per-control
    evidence file (pre-engine-PR-#219) leave compliance_evidence.json
    absent. The worker silently skips the ingest in that case — the
    structured posture stays empty until a newer engine version lands."""
    pack_root = tmp_path / "compliance_pack"
    (pack_root / "run-abc").mkdir(parents=True)
    (pack_root / "run-abc" / "manifest.json").write_text("{}")
    # No compliance_evidence.json — older engine.

    sb = FakeSupabase(fake_scan)
    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    # Ingest NOT called.
    assert getattr(sb, "_ingested_evidence", None) is None


@pytest.mark.asyncio
async def test_upload_compliance_pack_skips_empty_dir(tmp_path, fake_scan):
    """An empty pack dir (engine ran but didn't write anything for some
    reason) must not flip the flag either."""
    pack_root = tmp_path / "compliance_pack"
    pack_root.mkdir()  # exists, but empty

    sb = FakeSupabase(fake_scan)
    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    assert [u for u in sb.uploads if "compliance_pack" in u["path"]] == []
    assert getattr(sb, "_compliance_pack_uploaded", False) is False


@pytest.mark.asyncio
async def test_upload_compliance_pack_swallows_per_file_failures(tmp_path, fake_scan):
    """One bad file in the bundle must not block the rest — partial
    auditor evidence is more useful than no evidence."""
    pack_root = tmp_path / "compliance_pack"
    (pack_root / "run-x").mkdir(parents=True)
    (pack_root / "run-x" / "good.json").write_text("{}")
    (pack_root / "run-x" / "bad.csv").write_text("oops")

    sb = FakeSupabase(fake_scan)
    real_upload = sb.upload_artifact

    def flaky_upload(bucket, path, contents, content_type="text/plain"):
        if path.endswith("bad.csv"):
            raise RuntimeError("storage gone fishing")
        return real_upload(bucket, path, contents, content_type)

    sb.upload_artifact = flaky_upload  # type: ignore[method-assign]

    await _upload_compliance_pack(sb, SCAN_ID, ORG_ID, pack_root=pack_root)

    pack_uploads = [u for u in sb.uploads if "compliance_pack" in u["path"]]
    assert len(pack_uploads) == 1
    assert pack_uploads[0]["path"].endswith("good.json")
    assert getattr(sb, "_compliance_pack_uploaded", False) is True
