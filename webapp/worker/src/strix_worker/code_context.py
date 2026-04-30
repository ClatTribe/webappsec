"""Source-code context for LLM-based finding triage.

This is the worker side of "AI triage with codebase context (RAG)" — Stage
A.1. Today the triage LLM sees only the finding markdown, so when it judges
reachability ("is this exploitable?") it has to *guess* from prose. With the
actual source around the cited line it can *confirm*.

Stage A.1 (this module): for `local_code` targets the source is on the
worker host. We extract file references from the finding markdown, resolve
them under the target root (with strict path-traversal guards), and read a
window of lines around any cited line numbers. The result is a small,
bounded prompt section the triage LLM consumes alongside the description.

Out of scope here, deferred to Stage A.2:
- `repository` targets — Strix clones the repo inside its sandbox container,
  which is gone by triage time. To support these we'd shallow-clone in the
  worker at triage finalize, which means re-materialising integration
  credentials past the original `with materialize_credentials(...)` scope.
  Real work, separate PR.
- pgvector-backed similarity search to surface *related* code beyond what
  Strix explicitly mentioned. The roadmap row's L-effort estimate covers
  that; A.1 ships the headline value (Strix's mentioned files visible to
  the LLM) at a fraction of the cost.

The whole function is best-effort. If anything goes wrong — file missing,
binary file, path traversal attempt, oversize file — we return None and the
finding is triaged exactly as it was before this module existed.
"""

from __future__ import annotations

import logging
import os
import re
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
    scan_targets: list[dict[str, Any]],
) -> str | None:
    """Build a bounded source-code context block for one finding's triage.

    Returns the formatted context string (with file headers + line-numbered
    snippets) ready to embed in the prompt, or None if no usable source
    could be assembled.

    Strategy:
      - Resolve the local_code root for this scan, if any.
      - Extract file refs from the finding's `description_md` (and the
        structured `affected_files` column when populated by the worker).
      - Read each ref's file window, in order, until we hit either the
        per-finding char budget or the per-finding file count cap.
      - Skip files that don't exist, look binary, escape the root, or
        refuse to decode.
    """
    root = _local_code_root(scan_targets)
    if not root:
        return None  # No source we can reach for this scan.

    md = finding.get("description_md") or ""
    refs = extract_file_references(md)

    # `affected_files` is a JSONB column — list of strings, or list of
    # objects with {path, line}. Gracefully accept either.
    raw_aff = finding.get("affected_files") or []
    if isinstance(raw_aff, list):
        for entry in raw_aff:
            if isinstance(entry, str):
                refs.append(FileRef(path=entry, line=None))
            elif isinstance(entry, dict):
                p = entry.get("path") or entry.get("file")
                if p:
                    line_v = entry.get("line")
                    refs.append(FileRef(path=p, line=int(line_v) if line_v else None))

    # De-dup again after merging the two sources, preserving order.
    seen_paths: set[str] = set()
    unique_refs: list[FileRef] = []
    for r in refs:
        if r.path not in seen_paths:
            seen_paths.add(r.path)
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
