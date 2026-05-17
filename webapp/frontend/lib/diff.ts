// Minimal unified-diff applier for engine-proposed patches.
//
// Strix's Patcher specialist caps each diff at 16KB and produces well-
// formed unified diffs — no rename/copy/binary headers, no nested file
// modes, no context tricks. We need just enough to turn:
//
//   --- a/src/auth.py
//   +++ b/src/auth.py
//   @@ -42,8 +42,9 @@ def login(request):
//        username = request.form['username']
//        password = request.form['password']
//   -    query = f"SELECT … '{username}' AND password = '{password}'"
//   -    result = db.execute(query)
//   +    query = "SELECT … WHERE username = %s AND password = %s"
//   +    result = db.execute(query, (username, password))
//        if result:
//            return 'ok'
//
// into a per-file (path, newContent) tuple keyed by the destination path.
//
// We deliberately don't use `diff` / `parse-diff` npm packages — they
// add ~80KB of bundle for a problem we own end-to-end. This module is
// ~120 LoC, has zero deps, and fails closed on anything it doesn't
// recognise.

export interface FileEdit {
  /** Destination path (the `b/` side of `+++ b/<path>`). */
  path: string;
  /** Source path (`a/` side). Same as `path` for in-place edits;
   *  rename detection is out of scope. */
  oldPath: string;
  /** Whether the destination is being created (no `a/` source). */
  isNewFile: boolean;
  /** Whether the source is being deleted (no `b/` destination). */
  isDeleted: boolean;
  /** Parsed hunks. */
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line carries its leading marker ('+', '-', ' ') preserved. */
  lines: string[];
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(`diff parse error: ${message}`);
    this.name = 'DiffParseError';
  }
}

export class DiffApplyError extends Error {
  constructor(message: string, public path: string) {
    super(`diff apply error in ${path}: ${message}`);
    this.name = 'DiffApplyError';
  }
}

/** Parse a unified diff into per-file edits. Throws DiffParseError on
 *  malformed input. */
export function parseUnifiedDiff(diff: string): FileEdit[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const edits: FileEdit[] = [];
  let i = 0;

  while (i < lines.length) {
    // Skip blank lines + `diff ...` headers + `index ...` headers between
    // files. We resync on the next `--- ` line.
    if (!lines[i].startsWith('--- ')) {
      i++;
      continue;
    }
    const minus = lines[i];
    if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) {
      throw new DiffParseError(`expected '+++' line after '${minus}'`);
    }
    const plus = lines[i + 1];
    i += 2;

    const oldPath = stripPathPrefix(minus.slice(4).trim());
    const newPath = stripPathPrefix(plus.slice(4).trim());
    const isNewFile = oldPath === '/dev/null';
    const isDeleted = newPath === '/dev/null';
    const path = isDeleted ? oldPath : newPath;

    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      const header = lines[i];
      const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) throw new DiffParseError(`malformed hunk header: ${header}`);
      const oldStart = parseInt(m[1], 10);
      const oldLines = m[2] ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3], 10);
      const newLines = m[4] ? parseInt(m[4], 10) : 1;
      i++;

      const hunkLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('diff ')) break;
        // Empty trailing line is the file terminator from a tool — skip.
        if (l === '' && (i === lines.length - 1 || lines[i + 1] === '')) {
          i++;
          continue;
        }
        if (l[0] === '+' || l[0] === '-' || l[0] === ' ' || l === '\\ No newline at end of file') {
          hunkLines.push(l);
          i++;
        } else if (l === '') {
          // Empty line inside a hunk is a context line with no content.
          hunkLines.push(' ');
          i++;
        } else {
          break;
        }
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }

    edits.push({ path, oldPath, isNewFile, isDeleted, hunks });
  }

  if (edits.length === 0) {
    throw new DiffParseError('no files found in diff');
  }
  return edits;
}

/** Apply a single FileEdit to its original content. Returns the new
 *  content. Throws DiffApplyError when a hunk's context lines don't
 *  match the file — same semantics as `git apply --check` failing. */
export function applyEdit(edit: FileEdit, originalContent: string): string {
  if (edit.isDeleted) return ''; // caller decides whether to delete the blob
  if (edit.isNewFile) {
    // Build content from the hunk's added lines only.
    const out: string[] = [];
    for (const hunk of edit.hunks) {
      for (const line of hunk.lines) {
        if (line[0] === '+') out.push(line.slice(1));
      }
    }
    return out.join('\n') + (out.length > 0 ? '\n' : '');
  }

  const originalLines = originalContent.replace(/\r\n/g, '\n').split('\n');
  // Drop the trailing empty element from `.split('\n')` on a file ending
  // in '\n' so line numbering matches git's 1-based, no-trailing-empty
  // convention.
  const hadTrailingNewline = originalContent.endsWith('\n');
  if (hadTrailingNewline && originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }

  // We rebuild the file by walking the hunks in order. Lines outside
  // any hunk pass through unchanged.
  const output: string[] = [];
  let cursor = 0; // 0-indexed into originalLines

  for (const hunk of edit.hunks) {
    // Copy unchanged lines up to the hunk's start (1-indexed → 0-indexed).
    const hunkStart = hunk.oldStart - 1;
    while (cursor < hunkStart) {
      if (cursor >= originalLines.length) {
        throw new DiffApplyError(
          `hunk starts at line ${hunk.oldStart} but file has only ${originalLines.length} lines`,
          edit.path,
        );
      }
      output.push(originalLines[cursor]);
      cursor++;
    }

    // Apply the hunk: consume context + deletions from the original
    // (verifying each), emit context + additions to the output.
    for (const line of hunk.lines) {
      if (line === '\\ No newline at end of file') continue;
      const marker = line[0];
      const body = line.slice(1);
      if (marker === ' ') {
        if (cursor >= originalLines.length || originalLines[cursor] !== body) {
          throw new DiffApplyError(
            `context mismatch at line ${cursor + 1}: expected ${JSON.stringify(body)}, got ${JSON.stringify(originalLines[cursor] ?? '<EOF>')}`,
            edit.path,
          );
        }
        output.push(body);
        cursor++;
      } else if (marker === '-') {
        if (cursor >= originalLines.length || originalLines[cursor] !== body) {
          throw new DiffApplyError(
            `deletion mismatch at line ${cursor + 1}: expected ${JSON.stringify(body)}, got ${JSON.stringify(originalLines[cursor] ?? '<EOF>')}`,
            edit.path,
          );
        }
        cursor++;
      } else if (marker === '+') {
        output.push(body);
      } else {
        throw new DiffApplyError(`unrecognised hunk line marker: ${JSON.stringify(line)}`, edit.path);
      }
    }
  }

  // Copy any tail lines past the last hunk.
  while (cursor < originalLines.length) {
    output.push(originalLines[cursor]);
    cursor++;
  }

  return output.join('\n') + (hadTrailingNewline ? '\n' : '');
}

/** Strip the conventional `a/` or `b/` prefix git applies to unified-
 *  diff path headers. */
function stripPathPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
