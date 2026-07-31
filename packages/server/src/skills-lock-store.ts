/**
 * Persistence boundary for the committed import lockfile (`.ok/skills-lock.json`).
 *
 * The sibling machine-local placement ledger got serialization and atomic writes;
 * this file — which is COMMITTED, shared with teammates, and the only record of
 * where an imported skill came from — had neither. The asymmetry was backwards.
 *
 * Serialized, because every mutation is read-whole → edit → write-whole with an
 * await in the middle, and on the import paths that await is a network clone.
 * Unserialized, a reimport that started before a concurrent import finished
 * would write back its stale snapshot and erase the other skill's entry: the
 * bundle on disk stays fine, so the loss is silent until someone tries to update
 * that skill and is told it was never imported.
 *
 * Atomic, because a truncated lockfile parses as `null`, which `readSkillsLock`
 * fails soft into an EMPTY lock — losing origin, Modified and Revert for every
 * imported skill in the project at once.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import {
  emptySkillsLock,
  parseSkillsLock,
  type SkillsLock,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedMkdir } from './fs-traced.ts';
import { TRACED_FS_ADAPTER } from './installed-skills-marker.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

/**
 * Read the lockfile, or an empty one. Fail-soft on a corrupt file is deliberate
 * (a bad lockfile must not break an import), which is exactly why the write side
 * has to be atomic — see the module docblock.
 */
export function readSkillsLockFile(lockPath: string): SkillsLock {
  if (!existsSync(lockPath)) return emptySkillsLock();
  const parsed = parseSkillsLock(readFileSync(lockPath, 'utf-8'));
  if (parsed) return parsed;
  // Present but unparseable. Continuing with an empty lock is the deliberate
  // fail-soft, but it silently drops origin, Modified, and Revert for every
  // imported skill at once — the operator gets no other signal that it
  // happened, and the next write persists the empty lock over the corrupt one.
  getLogger('skills-lock').warn(
    { lockPath },
    'skills-lock.json is unreadable; continuing with an empty lock (import provenance for this project is lost)',
  );
  return emptySkillsLock();
}

const serializeLockWrite = createKeyedSerializer();

/**
 * Read-modify-write the lockfile under a per-path lock. `mutate` receives the
 * freshly-read lock and returns the one to persist (or nothing, to persist the
 * object it mutated in place).
 *
 * Read the lock INSIDE the callback — a snapshot taken before calling this is
 * the stale-write bug the serializer exists to prevent.
 */
export function mutateSkillsLock(
  lockPath: string,
  mutate: (lock: SkillsLock) => SkillsLock | undefined,
): Promise<void> {
  return serializeLockWrite(lockPath, async () => {
    const current = readSkillsLockFile(lockPath);
    const next = mutate(current) ?? current;
    await tracedMkdir(dirname(lockPath), { recursive: true });
    await atomicWriteFile(lockPath, `${JSON.stringify(next, null, 2)}\n`, {
      fs: TRACED_FS_ADAPTER,
    });
  });
}
