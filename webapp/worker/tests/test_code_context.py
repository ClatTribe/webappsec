"""Tests for the source-code context builder used by inline triage.

The contract under test:
  - `extract_file_references` pulls out path + optional line refs from
    finding markdown using bold-label and backtick patterns.
  - `gather_for_finding` resolves those refs under the local_code target
    root, reads a bounded line window, refuses path-traversal escapes,
    and skips binary / oversize files.
  - The whole thing is best-effort — every failure mode returns None
    rather than raising, so triage can keep running.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from strix_worker.code_context import (
    FileRef,
    extract_file_references,
    gather_for_finding,
    parse_code_analysis_section,
)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def test_extracts_paths_from_bold_label():
    md = """
# Some finding

**Affected files:** webapp/foo.py:42, webapp/bar.py

## Description
something
"""
    refs = extract_file_references(md)
    paths = [(r.path, r.line) for r in refs]
    assert ("webapp/foo.py", 42) in paths
    assert ("webapp/bar.py", None) in paths


def test_extracts_paths_from_inline_backticks():
    md = "The vulnerable line lives in `webapp/api/handler.py:128`."
    refs = extract_file_references(md)
    assert refs == [FileRef(path="webapp/api/handler.py", line=128)]


def test_dedups_and_upgrades_line_numbers():
    # First mention has no line, second does — we should keep the line.
    md = "see `webapp/foo.py` and also `webapp/foo.py:42`"
    refs = extract_file_references(md)
    assert refs == [FileRef(path="webapp/foo.py", line=42)]


def test_ignores_bare_words_without_separators():
    md = "Update README and rerun. (No path-shaped tokens here.)"
    assert extract_file_references(md) == []


def test_returns_empty_for_empty_markdown():
    assert extract_file_references("") == []
    assert extract_file_references(None) == []  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# gather_for_finding — local_code path
# ---------------------------------------------------------------------------


@pytest.fixture
def local_repo(tmp_path: Path) -> Path:
    """A synthetic local_code target rooted at tmp_path with realistic files."""
    (tmp_path / "webapp" / "api").mkdir(parents=True)
    (tmp_path / "webapp" / "api" / "handler.py").write_text(
        "\n".join(f"line_{i}" for i in range(1, 201)) + "\n"
    )
    (tmp_path / "webapp" / "small.py").write_text("only line\n")
    (tmp_path / "webapp" / "binary.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    return tmp_path


def _local_target(path: Path) -> dict:
    return {"type": "local_code", "value": str(path)}


def test_gathers_window_around_cited_line(local_repo):
    finding = {
        "description_md": "see `webapp/api/handler.py:100`",
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    assert "### webapp/api/handler.py" in out
    assert "(around line 100)" in out
    # Window centred on line 100, default 25 before / 25 after.
    assert "line_100" in out
    assert "line_75" in out
    assert "line_125" in out
    # Outside the window must not appear.
    assert "line_50" not in out
    assert "line_150" not in out


def test_falls_back_to_file_head_when_no_line(local_repo):
    finding = {
        "description_md": "**File:** webapp/api/handler.py",
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    assert "(head)" in out
    assert "line_1" in out
    # Default head is 80 lines.
    assert "line_80" in out
    assert "line_100" not in out


def test_returns_none_when_no_local_code_target(local_repo):
    finding = {"description_md": "see `webapp/api/handler.py:100`"}
    web_target = {"type": "web_application", "value": "https://example.com"}
    assert gather_for_finding(finding, scan_targets=[web_target]) is None


def test_returns_none_when_no_file_refs(local_repo):
    finding = {"description_md": "Generic prose without paths."}
    assert (
        gather_for_finding(finding, scan_targets=[_local_target(local_repo)]) is None
    )


def test_path_traversal_attempt_is_refused(local_repo, tmp_path):
    # Plant a "secret" file outside the target root that ../ escapes would hit.
    secret = tmp_path.parent / "outside_secret.py"
    secret.write_text("password = 'should-not-be-readable'\n")
    finding = {
        "description_md": "look at `../outside_secret.py:1`",
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    # Either None (no readable refs) or text that doesn't include the escape.
    assert out is None or "should-not-be-readable" not in out


def test_binary_files_are_skipped(local_repo):
    finding = {
        "description_md": "see `webapp/binary.png` and `webapp/api/handler.py:5`"
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    # The binary file's name shouldn't appear in a code block heading.
    assert "### webapp/binary.png" not in out
    # The text file we ALSO mentioned should be present.
    assert "### webapp/api/handler.py" in out


def test_missing_files_are_skipped(local_repo):
    finding = {
        "description_md": "see `webapp/does-not-exist.py:5` and `webapp/small.py`"
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    assert "does-not-exist" not in out
    assert "### webapp/small.py" in out


def test_oversize_files_are_skipped(local_repo):
    big = local_repo / "webapp" / "big.py"
    big.write_bytes(b"x" * (600 * 1024))  # > 512 KiB cap
    finding = {"description_md": "see `webapp/big.py`"}
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is None  # the only ref was unreadable


def test_affected_files_jsonb_supplements_markdown_refs(local_repo):
    finding = {
        "description_md": "Generic prose, no path mentions.",
        "affected_files": [
            "webapp/small.py",
            {"path": "webapp/api/handler.py", "line": 50},
        ],
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    assert "### webapp/small.py" in out
    assert "### webapp/api/handler.py" in out
    assert "(around line 50)" in out


def test_long_individual_lines_are_truncated(local_repo, tmp_path):
    long_file = local_repo / "webapp" / "long_line.py"
    long_file.write_text("x" * 5000 + "\nrest of file\n")
    finding = {"description_md": "see `webapp/long_line.py:1`"}
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    assert "…truncated" in out
    # Make sure we didn't dump the whole 5KB line into the prompt.
    assert "x" * 1000 not in out


# ---------------------------------------------------------------------------
# parse_code_analysis_section — parses Strix's `## Code Analysis` markdown
# ---------------------------------------------------------------------------


# Faithful sample of what Strix's tracer.py writes (see strix/telemetry/tracer.py
# lines 699-727). Indentation and fence placement copied exactly.
_STRIX_CODE_ANALYSIS_MD = """\
# Some finding

**Severity:** HIGH

## Description

Stuff.

## Code Analysis

**Location 1:** `webapp/api/auth.py` (line 42)
  user-input flows into raw SQL
  ```
  def login(request):
      sql = "SELECT * FROM users WHERE name='" + request.GET['u'] + "'"
      return db.execute(sql)
  ```

  **Suggested Fix:**
```diff
- sql = "SELECT * FROM users WHERE name='" + request.GET['u'] + "'"
+ sql = "SELECT * FROM users WHERE name=%s"
+ db.execute(sql, [request.GET['u']])
```

**Location 2:** `webapp/utils/x.py` (lines 10-15)
  ```
  def helper():
      pass
  ```

## Remediation

Use parameterised queries.
"""


def test_parses_single_location_with_path_and_line():
    locs = parse_code_analysis_section(_STRIX_CODE_ANALYSIS_MD)
    assert len(locs) == 2
    first = locs[0]
    assert first["path"] == "webapp/api/auth.py"
    assert first["line"] == 42
    assert "end_line" not in first  # single line, no range
    assert "raw SQL" in first["label"]


def test_parses_line_range():
    locs = parse_code_analysis_section(_STRIX_CODE_ANALYSIS_MD)
    second = locs[1]
    assert second["path"] == "webapp/utils/x.py"
    assert second["line"] == 10
    assert second["end_line"] == 15


def test_extracts_snippet_text():
    locs = parse_code_analysis_section(_STRIX_CODE_ANALYSIS_MD)
    snippet = locs[0]["snippet"]
    assert "def login(request):" in snippet
    # The 2-space indentation Strix adds to the first line of the snippet
    # block must be stripped — Python code shouldn't gain a phantom indent.
    assert not snippet.startswith("  def login")


def test_extracts_suggested_fix_diff():
    locs = parse_code_analysis_section(_STRIX_CODE_ANALYSIS_MD)
    first = locs[0]
    assert "fix_before" in first
    assert "fix_after" in first
    assert "WHERE name='\" + request.GET" in first["fix_before"]
    assert "WHERE name=%s" in first["fix_after"]


def test_handles_missing_section():
    md = "# Title\n\n## Description\n\nNo code analysis here.\n"
    assert parse_code_analysis_section(md) == []


def test_handles_empty_or_none_input():
    assert parse_code_analysis_section("") == []
    assert parse_code_analysis_section(None) == []


def test_section_terminates_at_next_h2():
    """The Code Analysis section must NOT swallow content from `## Remediation`."""
    locs = parse_code_analysis_section(_STRIX_CODE_ANALYSIS_MD)
    # If we'd over-greedy the section, we'd parse "## Remediation" as a
    # location. The test fixture has exactly 2 locations.
    assert len(locs) == 2


# ---------------------------------------------------------------------------
# gather_for_finding — structured-snippet path (preferred over disk read)
# ---------------------------------------------------------------------------


def test_structured_snippets_render_without_disk_access():
    """When affected_files carries snippets, no scan_targets or local_code
    root are needed — we render straight from the JSONB row."""
    finding = {
        "description_md": "Some report.",
        "affected_files": [
            {
                "path": "webapp/api/auth.py",
                "line": 42,
                "snippet": "def login():\n    return SQL_INJECTION",
                "label": "user-input flows into raw SQL",
            },
        ],
    }
    out = gather_for_finding(finding, scan_targets=[])
    assert out is not None
    assert "### webapp/api/auth.py  (line 42)" in out
    assert "user-input flows into raw SQL" in out
    assert "def login():" in out
    assert "SQL_INJECTION" in out


def test_structured_path_works_for_any_target_type():
    """Stage A.0 works for repository targets too — no source on disk needed
    because Strix already shipped the snippet."""
    finding = {
        "affected_files": [
            {"path": "src/a.py", "line": 10, "snippet": "vulnerable_code()"},
        ],
    }
    repo_target = {"type": "repository", "value": "https://github.com/x/y"}
    out = gather_for_finding(finding, scan_targets=[repo_target])
    assert out is not None
    assert "vulnerable_code()" in out


def test_suggested_fix_diff_appears_in_context():
    finding = {
        "affected_files": [
            {
                "path": "webapp/foo.py",
                "line": 5,
                "snippet": "old_code()",
                "fix_before": "old_code()",
                "fix_after": "new_code()",
            },
        ],
    }
    out = gather_for_finding(finding, scan_targets=[])
    assert out is not None
    assert "Suggested fix (from agent):" in out
    assert "- old_code()" in out
    assert "+ new_code()" in out


def test_line_range_renders_correctly():
    finding = {
        "affected_files": [
            {
                "path": "webapp/foo.py",
                "line": 10,
                "end_line": 20,
                "snippet": "lines 10-20 of code",
            },
        ],
    }
    out = gather_for_finding(finding, scan_targets=[])
    assert out is not None
    assert "(lines 10-20)" in out


def test_disk_read_used_when_only_paths_no_snippets(local_repo):
    """Backward-compatible fallback: if affected_files has only paths and
    we have a local_code target, fall back to disk read."""
    finding = {
        "description_md": "see `webapp/api/handler.py:50`",
        "affected_files": [{"path": "webapp/api/handler.py"}],  # no snippet!
    }
    out = gather_for_finding(finding, scan_targets=[_local_target(local_repo)])
    assert out is not None
    # The disk-read fallback uses "around line N" wording.
    assert "around line 50" in out
    assert "line_50" in out
