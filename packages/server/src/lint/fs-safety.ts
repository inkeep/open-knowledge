/**
 * Shared filesystem safety primitives for the lint read/write surfaces:
 * lexical path containment (callers pair it with realpath re-checks for
 * symlink escapes) and the traced atomic tmp+rename write.
 */

import { isAbsolute, relative } from 'node:path';
import { tracedRenameSync, tracedUnlinkSync, tracedWriteFileSync } from '../fs-traced.ts';

/** Whether `path` sits at or under `root`, lexically. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Atomic write (tmp + rename), traced; never leaves the tmp file behind. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    tracedWriteFileSync(tmp, content, 'utf-8');
    tracedRenameSync(tmp, file);
  } catch (err) {
    // The tmp file sits in user-visible content space — never leave an
    // orphan behind on a failed write/rename (same pattern as
    // config-persistence.ts).
    try {
      tracedUnlinkSync(tmp);
    } catch {
      // tmp may not exist if the write itself failed.
    }
    throw err;
  }
}
