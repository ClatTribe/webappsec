"""Source-code context for LLM-based finding triage.

This is the worker side of "AI triage with codebase context (RAG)". Today
the triage LLM sees only the finding markdown, so when it judges
reachability ("is this exploitable?") it has to *guess* from prose. With
the actual source around the cited line it can *confirm*.

There are two paths in here, in order of preference:

1. **Strix's structured `code_locations`** — Strix already extracts file
   path, line range, the snippet, and (often) a suggested-fix diff for
   every code-related finding. It serialises these into the `## Code
   Analysis` section of `vuln-NNNN.md`. Our `_ingest_finding` parses that
   section back into structured form and persists it in
   `findings.affected_files` (JSONB). At triage time we read those rows
   directly into the prompt — no file IO, works for *every* target type
   (repository, local_code, anything Strix produces locations for).

2. **Disk-read fallback** for local_code targets when no structured
   `code_locations` exist. We extract path-shaped tokens from
   `description_md`, resolve them under the target root with strict
   traversal guards, and read line windows. Slower, less precise, only
   used when Strix didn't give us structured data.

The whole function is best-effort. Every failure mode returns None and
the finding is triaged exactly as it was before this module existed.
"""

from __future__ import annotations

import logging
import os
import re
import textwrap
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


# Per-finding context budget. Plenty for ~3 files at 50–80 lines each.
# Triage already includes the 8000-char description; the LLM context window
# is 128K+ for Gemini-class models, so this isn't tight on the model side.
# It's tight to keep the triage *prompt* legible for debugging + reviewable
# in tests.
_MAX_CONTEXT_CHARS = 5000
_MAX_FILES_PER_FINDING = 4
_MAX_FILE_SIZE_BYTES = 512 * 1024  # 512 KiB — anything bigger is a generated artefact
_LINES_BEFORE = 25
_LINES_AFTER = 25
_FALLBACK_HEAD_LINES = 80  # when no specific line cited, show the file head

# Extensions worth showing to the LLM. Anything else is treated as binary.
_TEXT_EXTS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs",
    ".c", ".cc", ".cpp", ".h", ".hpp",
    ".sh", ".bash", ".zsh",
    ".sql", ".graphql", ".proto",
    ".html", ".css", ".scss", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
    ".md", ".rst", ".txt",
    ".tf", ".hcl",
    ".dockerfile", "",  # ".dockerfile" rare; bare extension for `Dockerfile`
}


@dataclass(frozen=True)
class FileRef:
    """A file path mentioned in a finding, optionally with a line number."""
    path: str
    line: int | None


# ---------------------------------------------------------------------------
# Parsing Strix's `## Code Analysis` markdown section
# ---------------------------------------------------------------------------
#
# Strix's tracer.py serialises each code_location as roughly:
#
#     **Location 1:** `webapp/api/foo.py` (line 42)
#       short label
#       ```
#       snippet body
#       ```
#
#       **Suggested Fix:**
#     ```diff
#     - old line
#     + new line
#     ```
#
# We invert this back into the same dict shape Strix's in-memory
# `code_locations` had, so downstream code can treat it as ground truth.
# This parser is intentionally lenient: Strix's markdown writer has minor
# indentation quirks (only the first line of a snippet gets indented
# after the opening fence), and older versions may differ. When in doubt,
# capture less — it's better to miss a snippet than to include garbage.

_CODE_ANALYSIS_HEADING = re.compile(r"^##\s+Code\s+Analysis\s*$", re.MULTILINE | re.IGNORECASE)
_LOCATION_HEADER = re.compile(
    r"\*\*Location\s+\d+:\*\*\s*"
    r"`(?P<path>[^`\n]+)`"
    r"(?:\s*\(lines?\s+(?P<start>\d+)(?:\s*-\s*(?P<end>\d+))?\))?",
)
_SNIPPET_FENCE = re.compile(
    r"^[ \t]*```[a-zA-Z0-9_-]*\s*\n(?P<body>.*?)\n[ \t]*```",
    re.MULTILINE | re.DOTALL,
)
_DIFF_FENCE = re.compile(
    r"\*\*Suggested\s+Fix:?\*\*\s*\n[ \t]*```diff\s*\n(?P<body>.*?)\n[ \t]*```",
    re.IGNORECASE | re.DOTALL,
)


def parse_code_analysis_section(md: str | None) -> list[dict[str, Any]]:
    """Pull Strix's structured code_locations back out of a vuln markdown.

    Returns a list of dicts with the same keys Strix uses internally:
    `{path, line?, end_line?, label?, snippet?, fix_before?, fix_after?}`.
    Empty list when the section is absent or unparseable.

    The result is suitable to pass straight into `worker_insert_finding`'s
    `payload.affected_files` JSONB. Stable downstream contract.
    """
    if not md:
        return []
    heading = _CODE_ANALYSIS_HEADING.search(md)
    if not heading:
        return []

    # Section runs from the heading to the next H2 or EOF.
    section_start = heading.end()
    next_h2 = re.search(r"\n##\s+\S", md[section_start:])
    section_end = section_start + next_h2.start() if next_h2 else len(md)
    section = md[section_start:section_end]

    # Split on Location boundaries — keep the boundary text in each part.
    raw_blocks = re.split(r"(?=\*\*Location\s+\d+:\*\*)", section)
    blocks = [b for b in raw_blocks if "**Location" in b]

    out: list[dict[str, Any]] = []
    for block in blocks:
        loc = _parse_one_location(block)
        if loc and loc.get("path"):
            out.append(loc)
    return out


def _parse_one_location(block: str) -> dict[str, Any] | None:
    header = _LOCATION_HEADER.search(block)
    if not header:
        return None
    loc: dict[str, Any] = {"path": header.group("path").strip()}
    if header.group("start"):
        loc["line"] = int(header.group("start"))
    if header.group("end"):
        loc["end_line"] = int(header.group("end"))

    # Body = everything after the header line.
    body_start = header.end()
    body = block[body_start:]

    # Snippet: first non-diff fence after the header. Strix uses bare ```
    # for snippets and ```diff for suggested fixes — match the bare form
    # by excluding `diff`-tagged opens.
    snippet = _extract_snippet(body)
    if snippet:
        loc["snippet"] = snippet

    diff = _DIFF_FENCE.search(body)
    if diff:
        before, after = _split_unified_diff(diff.group("body"))
        if before:
            loc["fix_before"] = before
        if after:
            loc["fix_after"] = after

    # Label: the first non-empty, non-fence, non-bold line directly under
    # the header — Strix indents it by 2 spaces.
    label = _extract_label(body)
    if label:
        loc["label"] = label

    return loc


def _extract_snippet(body: str) -> str | None:
    """First triple-fence block in `body` that isn't a ```diff block."""
    # Trim everything from `**Suggested Fix:**` onward — that's diff territory.
    cutoff = re.search(r"\*\*Suggested\s+Fix:?\*\*", body, re.IGNORECASE)
    search_in = body[: cutoff.start()] if cutoff else body
    m = _SNIPPET_FENCE.search(search_in)
    if not m:
        return None
    raw = m.group("body")
    # Strix only indents the first line of the snippet by 2 spaces; the
    # rest is whatever indentation the source had. textwrap.dedent does
    # the right thing only on uniform indents, so we manually peel a
    # leading 2-space prefix on a per-line basis if present.
    lines = raw.splitlines()
    return "\n".join(line[2:] if line.startswith("  ") else line for line in lines).rstrip()


def _split_unified_diff(diff_body: str) -> tuple[str, str]:
    """Pull `- ` and `+ ` lines out of a unified-style diff block."""
    befores: list[str] = []
    afters: list[str] = []
    for line in diff_body.splitlines():
        if line.startswith("- "):
            befores.append(line[2:])
        elif line.startswith("+ "):
            afters.append(line[2:])
    return "\n".join(befores), "\n".join(afters)


def _extract_label(body: str) -> str | None:
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("```") or stripped.startswith("**"):
            return None
        return stripped
    return None


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

# Match a `**Label:** body` block. The colon may live *inside* the bold
# markers (`**Affected files:**`) or just after them (`**File**: ...`); we
# accept either. Body extends to a blank line, the next bold-label, or EOF.
_BOLD_LABEL_RE = re.compile(
    r"\*\*(?P<label>[A-Za-z][A-Za-z ]+?):?\*\*\s*:?\s+(?P<body>.+?)(?=\n\s*\n|\n\*\*|\Z)",
    re.DOTALL,
)

# Labels we accept as "this body contains a file reference". Anything else
# (e.g. **Severity:**, **Found:**) is ignored even though it parses.
_FILE_LABELS = {
    "file", "files", "affected", "affected file", "affected files",
    "source", "source file", "location", "path", "paths",
}

# Path-like token: at least one directory separator (so plain words like
# `README` don't match) and an optional `:LINE` suffix. We forbid the slash
# from starting the match (no absolute paths — those are unlikely-correct
# ref strings in finding markdown).
_PATH_LIKE_RE = re.compile(
    r"""
    (?<![\w/.])
    (?P<path>
        [A-Za-z0-9_.\-]+
        (?:/[A-Za-z0-9_.\-]+)+    # at least one slash
    )
    (?::(?P<line>\d{1,6}))?        # optional :LINE
    (?![\w/])
    """,
    re.VERBOSE,
)
# Inline backtick paths: `webapp/foo.py:42`
_BACKTICK_RE = re.compile(
    r"`(?P<path>[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)+)(?::(?P<line>\d{1,6}))?`"
)


def extract_file_references(md: str) -> list[FileRef]:
    """Pull file paths (with optional line numbers) out of finding markdown.

    Returns deduplicated refs in source order. Conservative — we'd rather
    miss a reference than try to read a non-file string. The bold-label
    block wins on precision; backticks catch the inline-mention case; the
    bare path-shape regex is the last resort.
    """
    if not md:
        return []

    seen: dict[str, int | None] = {}
    order: list[str] = []

    def _add(path: str, line_str: str | None) -> None:
        path = path.strip().rstrip(".,;:)")
        if not path or " " in path:
            return
        if path in seen:
            # If the new ref carries a line number and the old didn't, upgrade.
            if seen[path] is None and line_str:
                seen[path] = int(line_str)
            return
        seen[path] = int(line_str) if line_str else None
        order.append(path)

    # 1. Bold-label blocks (highest signal). We only mine bodies whose label
    #    actually names a file/path field — `**Severity:** HIGH` shouldn't
    #    contribute even if its body happens to contain a path-shaped token.
    for label_match in _BOLD_LABEL_RE.finditer(md):
        label = label_match.group("label").strip().lower()
        if label not in _FILE_LABELS:
            continue
        body = label_match.group("body")
        for m in _PATH_LIKE_RE.finditer(body):
            _add(m.group("path"), m.group("line"))

    # 2. Inline backticks containing path-shaped tokens.
    for m in _BACKTICK_RE.finditer(md):
        _add(m.group("path"), m.group("line"))

    # 3. Bare path-shape mentions in prose. Last priority — many false
    #    positives (e.g. `requirements.txt` mentioned as a name). We only
    #    keep refs that already passed one of the higher-signal patterns;
    #    the bare regex is mostly useful for line numbers found near a
    #    path we already know about. Skip this pass for now — too noisy.

    return [FileRef(path=p, line=seen[p]) for p in order]


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def _looks_like_text(path: str) -> bool:
    base = os.path.basename(path)
    if base in {"Dockerfile", "Makefile", "Procfile", "Brewfile"}:
        return True
    _, ext = os.path.splitext(path)
    return ext.lower() in _TEXT_EXTS


def _resolve_under_root(root: str, ref: str) -> str | None:
    """Resolve `ref` (relative path) under `root`, refusing path-traversal.

    Returns the absolute, real path if it lives under `root`. Returns None
    if the path escapes (`../../etc/passwd`), if `root` itself isn't a
    directory, or if either path can't be resolved.
    """
    try:
        root_real = os.path.realpath(root)
        if not os.path.isdir(root_real):
            return None
        candidate = os.path.realpath(os.path.join(root_real, ref))
        # Containment check — `os.path.commonpath` raises on different drives;
        # we approximate with a prefix match plus a path-component boundary.
        prefix = root_real.rstrip(os.sep) + os.sep
        if candidate != root_real and not candidate.startswith(prefix):
            return None
        if not os.path.isfile(candidate):
            return None
        return candidate
    except (OSError, ValueError):
        return None


def _read_window(abs_path: str, line: int | None) -> str | None:
    """Read a window of lines around `line`, or the file head if no line.

    Returns the formatted snippet (with line-number gutter) or None if the
    file is too big, binary, or unreadable.
    """
    try:
        st = os.stat(abs_path)
    except OSError:
        return None
    if st.st_size > _MAX_FILE_SIZE_BYTES:
        return None
    try:
        with open(abs_path, encoding="utf-8", errors="strict") as fh:
            all_lines = fh.readlines()
    except (OSError, UnicodeDecodeError):
        return None

    total = len(all_lines)
    if line is None:
        start = 0
        end = min(total, _FALLBACK_HEAD_LINES)
    else:
        # 1-indexed line numbers, clamped.
        target = max(1, min(line, total))
        start = max(0, target - 1 - _LINES_BEFORE)
        end = min(total, target + _LINES_AFTER)

    snippet = []
    width = len(str(end))
    for i in range(start, end):
        ln = i + 1
        # Trim individual line length so a single 5000-char minified line
        # can't blow the budget.
        text = all_lines[i].rstrip("\n")
        if len(text) > 200:
            text = text[:200] + "  # …truncated"
        snippet.append(f"{ln:>{width}} | {text}")
    return "\n".join(snippet)


# ---------------------------------------------------------------------------
# Per-finding orchestrator
# ---------------------------------------------------------------------------

def _local_code_root(scan_targets: list[dict[str, Any]]) -> str | None:
    """If any of this scan's targets is `local_code`, return its absolute root.

    The worker passes `target["value"]` straight to Strix as the path-to-scan,
    so it's already host-absolute. We just verify it's a directory.
    """
    for t in scan_targets:
        if (t.get("type") == "local_code") and t.get("value"):
            root = t["value"]
            if os.path.isdir(root):
                return os.path.realpath(root)
    return None


def gather_for_finding(
    finding: dict[str, Any],
    *,
    scan_targets: list[dict[str, Any]] | None = None,
) -> str | None:
    """Build a bounded source-code context block for one finding's triage.

    Two paths, in preference order:

      1. **Structured snippets from `affected_files`** (Strix's own
         `code_locations`). When present, we render the snippets directly
         into the prompt — no file IO, no path-traversal exposure, works
         for repository targets too. This is the common case.

      2. **Disk read** for `local_code` targets when no structured
         snippets exist. Extract file refs from `description_md`, resolve
         under the target root, read line windows.

    Returns the formatted context string (with file headers + snippets +
    optional fix-diff blocks) or None if no usable source could be
    assembled.
    """
    structured = _structured_chunks(finding)
    if structured:
        return structured

    if scan_targets:
        return _disk_chunks(finding, scan_targets)
    return None


def _structured_chunks(finding: dict[str, Any]) -> str | None:
    """Render `affected_files` entries that already carry snippets.

    Each entry can be either a path string (no usable structured data, so
    skipped here) or an object with at least `path` + `snippet`. Strix
    produces the latter; we just format them.
    """
    raw = finding.get("affected_files") or []
    if not isinstance(raw, list):
        return None

    chunks: list[str] = []
    used = 0
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if not entry.get("snippet"):
            continue  # No snippet to render — defer to disk-read fallback.
        path = entry.get("path") or entry.get("file")
        if not path:
            continue

        line = entry.get("line") or entry.get("start_line")
        end_line = entry.get("end_line")
        line_label = _format_line_label(line, end_line)

        snippet = _bound_snippet(str(entry["snippet"]))
        label = entry.get("label")

        block_lines = [f"### {path}{line_label}"]
        if label:
            block_lines.append(_clamp_line(str(label), 200))
        block_lines.append("```")
        block_lines.append(snippet)
        block_lines.append("```")

        # If Strix attached a suggested-fix diff, surface it. This is
        # gold for triage: the agent's own fix proposal is a strong
        # reachability signal — if the patch makes sense, the bug is
        # real; if it patches dead code, the LLM should mark it dismiss.
        before = entry.get("fix_before")
        after = entry.get("fix_after")
        if before or after:
            block_lines.append("Suggested fix (from agent):")
            block_lines.append("```diff")
            for ln in (before or "").splitlines():
                block_lines.append("- " + _clamp_line(ln, 200))
            for ln in (after or "").splitlines():
                block_lines.append("+ " + _clamp_line(ln, 200))
            block_lines.append("```")

        block = "\n".join(block_lines)
        if used + len(block) > _MAX_CONTEXT_CHARS:
            chunks.append(
                f"_(further locations truncated — context budget reached at {used} chars)_"
            )
            break
        chunks.append(block)
        used += len(block)
        if len(chunks) >= _MAX_FILES_PER_FINDING:
            break

    if not chunks:
        return None
    return "\n\n".join(chunks)


def _format_line_label(line: int | None, end_line: int | None) -> str:
    if line and end_line and end_line != line:
        return f"  (lines {line}-{end_line})"
    if line:
        return f"  (line {line})"
    return ""


def _clamp_line(text: str, max_chars: int) -> str:
    if len(text) > max_chars:
        return text[:max_chars] + "  # …truncated"
    return text


def _bound_snippet(snippet: str) -> str:
    """Cap a snippet at the per-file char budget and clamp long lines."""
    out_lines = []
    total = 0
    for line in snippet.splitlines():
        line = _clamp_line(line, 200)
        if total + len(line) + 1 > _MAX_CONTEXT_CHARS // 2:
            out_lines.append("# …snippet truncated")
            break
        out_lines.append(line)
        total += len(line) + 1
    return "\n".join(out_lines)


def _disk_chunks(
    finding: dict[str, Any],
    scan_targets: list[dict[str, Any]],
) -> str | None:
    """Fallback: regex-extract file refs from prose, read from local_code disk."""
    root = _local_code_root(scan_targets)
    if not root:
        return None

    md = finding.get("description_md") or ""
    refs = extract_file_references(md)

    # `affected_files` may also list bare path strings (no snippet); merge them.
    raw_aff = finding.get("affected_files") or []
    if isinstance(raw_aff, list):
        for entry in raw_aff:
            if isinstance(entry, str):
                refs.append(FileRef(path=entry, line=None))
            elif isinstance(entry, dict) and not entry.get("snippet"):
                p = entry.get("path") or entry.get("file")
                if p:
                    line_v = entry.get("line") or entry.get("start_line")
                    refs.append(FileRef(path=p, line=int(line_v) if line_v else None))

    # De-dup, preserving order.
    seen: set[str] = set()
    unique_refs: list[FileRef] = []
    for r in refs:
        if r.path not in seen:
            seen.add(r.path)
            unique_refs.append(r)
    if not unique_refs:
        return None

    chunks: list[str] = []
    used = 0
    for ref in unique_refs[:_MAX_FILES_PER_FINDING]:
        if not _looks_like_text(ref.path):
            continue
        abs_path = _resolve_under_root(root, ref.path)
        if not abs_path:
            continue
        snippet = _read_window(abs_path, ref.line)
        if not snippet:
            continue
        header = (
            f"### {ref.path}"
            + (f"  (around line {ref.line})" if ref.line else "  (head)")
        )
        block = header + "\n```\n" + snippet + "\n```"
        if used + len(block) > _MAX_CONTEXT_CHARS:
            chunks.append(
                f"_(further files truncated — context budget reached at {used} chars)_"
            )
            break
        chunks.append(block)
        used += len(block)

    if not chunks:
        return None
    return "\n\n".join(chunks)
