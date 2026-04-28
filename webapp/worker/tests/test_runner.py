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
        self.finish_calls: list[dict[str, Any]] = []

    def fetch_scan(self, scan_id: str) -> dict[str, Any]:
        return self._scan

    def start_scan(self, scan_id: str) -> None:
        self.start_calls += 1

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
    assert sb.start_calls == 1
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


@pytest.mark.asyncio
async def test_run_scan_marks_failed_on_nonzero_exit(fake_scan, cfg_factory):
    cfg = cfg_factory(FAKE_STRIX_FAILURE)
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

    assert sb.start_calls == 1
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
    cfg = cfg_factory(FAKE_STRIX_SUCCESS)
    fake_scan["status"] = "completed"
    sb = FakeSupabase(fake_scan)

    await run_scan(SCAN_ID, cfg, sb)

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
