import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import {
  emptySkillsLock,
  parseSkillsLock,
  type SkillsLock,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { createKeyedSerializer } from './keyed-serializer.ts';
import { getLogger } from './logger.ts';

export function readSkillsLockFile(lockPath: string): SkillsLock {
  if (!existsSync(lockPath)) return emptySkillsLock();
  const parsed = parseSkillsLock(readFileSync(lockPath, 'utf-8'));
  if (parsed) return parsed;
  getLogger('skills-lock').warn(
    { lockPath },
    'skills-lock.json is unreadable; continuing with an empty lock (import provenance for this project is lost)',
  );
  return emptySkillsLock();
}

type LockRead = { ok: true; lock: SkillsLock } | { ok: false; reason: string; cause?: unknown };

function readSkillsLockForMutation(lockPath: string): LockRead {
  if (!existsSync(lockPath)) return { ok: true, lock: emptySkillsLock() };
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { ok: true, lock: emptySkillsLock() };
    return {
      ok: false,
      reason: code ? `it could not be read (${code})` : 'it could not be read',
      cause: err,
    };
  }
  const parsed = parseSkillsLock(raw);
  return parsed === null
    ? { ok: false, reason: 'its contents are not a skills lock this server understands' }
    : { ok: true, lock: parsed };
}

const serializeLockWrite = createKeyedSerializer();

export function mutateSkillsLock(
  lockPath: string,
  mutate: (lock: SkillsLock) => SkillsLock | undefined,
): Promise<void> {
  return serializeLockWrite(lockPath, async () => {
    const read = readSkillsLockForMutation(lockPath);
    if (!read.ok) {
      getLogger('skills-lock').error(
        { lockPath, reason: read.reason, err: read.cause },
        'refusing to rewrite skills-lock.json because it could not be read — rewriting it would replace every import it records with this one',
      );
      throw new Error(`Refusing to rewrite ${lockPath}: ${read.reason}`);
    }
    const current = read.lock;
    const next = mutate(current) ?? current;
    await tracedMkdir(dirname(lockPath), { recursive: true });
    await atomicWriteFile(lockPath, `${JSON.stringify(next, null, 2)}\n`, {
      fs: tracedAtomicFs,
    });
  });
}
