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
