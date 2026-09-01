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

const serializeLockWrite = createKeyedSerializer();

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
