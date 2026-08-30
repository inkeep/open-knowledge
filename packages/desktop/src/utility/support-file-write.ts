/**
 * Materialize a registry-authored launch support file beneath the PTY cwd.
 *
 * Trust boundary: the file lands below a project the user merely OPENED, whose
 * contents are attacker-controlled in the sense that matters here — a Windows
 * Git checkout with symlink support (`core.symlinks=true`) materializes tracked
 * symlinks and junctions on clone. The relative path is already pinned to one
 * literal shape by the message guard in `pty-host.ts`, but that guard is lexical
 * and a lexical guard cannot see a symlink: `join` resolves nothing, recursive
 * `mkdir` traverses an existing symlinked component rather than refusing it, and
 * `writeFile` follows a symlinked leaf. So the guard pins the string while the
 * resolved write location stays unconstrained.
 *
 * The order here is the same one the deck / trash / asset handlers apply:
 * canonicalize via realpath, then enforce containment on the RESOLVED path.
 * Applied per segment rather than once at the end, because "check afterwards"
 * would already have created directories under the attacker's target — the walk
 * refuses BEFORE anything outside the project is written. A segment that does
 * not exist yet is created as a real directory inside an already-verified
 * parent, so it cannot be a link; a segment that does exist is resolved and
 * contained before the walk descends into it. Windows junctions need no separate
 * handling: `realpath` collapses them exactly as it collapses symlinks, and
 * libuv reports junction mount points and symlinks as symbolic links at the
 * leaf, so the same `lstat` guard refuses either shape.
 *
 * The leaf is refused if it is a link of any kind — including one that resolves
 * back inside the project, since this path is one OK owns outright and a link
 * there is not a shape it authored. `lstat` gives that a uniform refusal on
 * every platform; `O_NOFOLLOW` then makes the POSIX write race-free against a
 * link planted between the check and the open. Windows has no `O_NOFOLLOW` in
 * libuv (and no `FILE_FLAG_OPEN_REPARSE_POINT` exposed through Node), so the
 * Windows leaf write remains TOCTOU-bounded by the `lstat` — the strongest
 * boundary reachable with current Node filesystem APIs. The per-segment
 * `realpath` checks refuse pre-existing symlink and junction escapes before the
 * walk creates anything outside the project. Node does not expose an openat-style
 * race-free directory traversal, so concurrent replacement of an already-verified
 * parent remains outside this boundary on every platform.
 *
 * A refusal throws, which routes into the caller's existing optional-support-file
 * degradation: the terminal opens a bare Claude launch (Claude then shows its own
 * trust prompt) instead of cancelling or writing outside the project.
 */

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TerminalLaunchCommand } from '@inkeep/open-knowledge-core';
import { isPathWithinProject } from '../shared/path-containment.ts';

/** Refusal code surfaced on the caller's `pty-host-support-file-materialize-failed`
 *  warn, so a containment refusal is distinguishable from a disk error (EROFS,
 *  ENOSPC, AV lock) at triage. Bounded cardinality — one literal. */
export const TERMINAL_SUPPORT_FILE_ESCAPE_CODE = 'ERR_TERMINAL_SUPPORT_FILE_ESCAPE';

function refuseEscape(detail: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`support file would escape the project root: ${detail}`, { cause }),
    { code: TERMINAL_SUPPORT_FILE_ESCAPE_CODE },
  );
}

/**
 * Reject traversal and separator ambiguity at the write boundary. The sole producer
 * pins the full registry-authored filename separately.
 */
function splitRelativePath(relativePath: string): { segments: string[]; leaf: string } {
  if (relativePath.length === 0 || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw refuseEscape('malformed relative path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw refuseEscape('malformed relative path');
  }
  const leaf = parts.pop();
  if (leaf === undefined || parts.length === 0) throw refuseEscape('malformed relative path');
  return { segments: parts, leaf };
}

export function materializeSupportFileSync(
  cwd: string,
  file: NonNullable<TerminalLaunchCommand['supportFile']>,
): void {
  // The host platform, NOT the logical launch platform the PTY host was told to
  // compose for. These are real paths on the machine actually running, and tests
  // drive win32 launch composition on a POSIX runner — reading the logical
  // platform here would apply win32 path grammar to POSIX paths and refuse
  // everything.
  const platform = process.platform;
  const { segments, leaf } = splitRelativePath(file.relativePath);

  const root = realpathSync(cwd);

  let dir = root;
  for (const segment of segments) {
    const next = join(dir, segment);
    try {
      mkdirSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw err;
    }
    try {
      dir = realpathSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
      throw refuseEscape(`directory segment ${segment} cannot be resolved`, error);
    }
    if (!isPathWithinProject(dir, root, platform)) {
      throw refuseEscape(`directory segment ${segment} resolves outside the project`);
    }
  }

  const target = join(dir, leaf);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw refuseEscape('settings file is a symlink');
  }
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, file.contents, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
}
