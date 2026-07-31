/**
 * What is sitting at a path, relative to a reference skill bundle.
 *
 * The shared low-level half of the two skill path classifiers —
 * `classifyInPlaceDest` (projection fan-out) and `classifyHostEntry` (store
 * migration). Both walk the identical skeleton (lstat → symlink? → realpath →
 * hash-compare) and both gate destructive writes, so keeping two copies of that
 * walk is the hazard: they can drift silently, and the thing they drift into is
 * deleting a directory or link the other one was written to preserve.
 *
 * This function answers ONLY the factual question and takes no position on what
 * to do about it. The verdicts are deliberately finer-grained than either
 * caller's enum, because the two callers legitimately map some of these to
 * different outcomes:
 *
 *   | on disk                        | projection        | migration              |
 *   | ------------------------------ | ----------------- | ---------------------- |
 *   | symlink → reference            | link-to-canonical | store-link             |
 *   | symlink → elsewhere            | link (removable)  | occupied(foreign-link) |
 *   | symlink → nothing (dangling)   | link (removable)  | occupied(foreign-link) |
 *   | dir that IS the reference      | canonical-dir     | same-copy              |
 *
 * One row the two USED to disagree on and no longer do: when the reference dir
 * itself is unreadable, projection always answered `different` while migration
 * hash-compared and could answer `same-copy`. The shared walk adopts
 * projection's answer for both, which is the safe direction because migration's
 * `same-copy` branch deletes the store dir. Pinned in the equivalence suite.
 *
 * Those rows are not oversights. Migration treats a dangling link as foreign on
 * purpose — an OK projection whose store source is about to move would not
 * dangle, so a dangling one belongs to something else and reconcile's orphan
 * pass owns it. Collapse that and the migration path starts deleting links it
 * was written to leave behind. The mapping therefore lives with each caller,
 * never here. `skill-path-classifier-equivalence.test.ts` pins every row.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';

export type SkillPathEntry =
  /** Nothing there, or unstattable. */
  | { kind: 'absent' }
  | {
      kind: 'symlink';
      /** `target` = resolves onto the reference bundle; `elsewhere` = resolves
       *  somewhere else; `dangling` = does not resolve at all. */
      resolution: 'target' | 'elsewhere' | 'dangling';
    }
  | {
      kind: 'dir';
      /** `is-target` = the reference bundle itself, reached by another path
       *  (a symlinked parent component); `same-content` = an independent
       *  directory whose bundle hash matches; `different` = anything else,
       *  including a directory whose realpath cannot be read. */
      identity: 'is-target' | 'same-content' | 'different';
    }
  /** Present but not a directory — a stray file. Never a bundle. */
  | { kind: 'other' };

/**
 * `referenceDir` may be a raw path or an already-resolved realpath; it is
 * realpath'd here either way, which is idempotent for the latter.
 */
export function inspectSkillPathEntry(
  path: string,
  referenceDir: string,
  referenceHash: string,
): SkillPathEntry {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: 'absent' };
  }

  if (st.isSymbolicLink()) {
    try {
      return realpathSync(path) === realpathSync(referenceDir)
        ? { kind: 'symlink', resolution: 'target' }
        : { kind: 'symlink', resolution: 'elsewhere' };
    } catch {
      return { kind: 'symlink', resolution: 'dangling' };
    }
  }

  if (!st.isDirectory()) return { kind: 'other' };

  try {
    if (realpathSync(path) === realpathSync(referenceDir)) {
      return { kind: 'dir', identity: 'is-target' };
    }
  } catch {
    // An unreadable realpath on something lstat called a directory is a broken
    // path, not a bundle worth hashing.
    return { kind: 'dir', identity: 'different' };
  }
  return parseSkillDir(path)?.contentHash === referenceHash
    ? { kind: 'dir', identity: 'same-content' }
    : { kind: 'dir', identity: 'different' };
}
