import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  parseSkillTargets,
  SKILL_TARGETS_REL,
  SKILL_TARGETS_SCHEMA_VERSION,
  type SkillTargetEditor,
  SkillTargetsSchema,
} from '@inkeep/open-knowledge-core';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { getLogger } from './logger.ts';

const logger = getLogger('skill-targets-store');

export function skillTargetsPath(projectDir: string): string {
  return join(projectDir, ...SKILL_TARGETS_REL);
}

export function readSkillTargets(projectDir: string): SkillTargetEditor[] | null {
  const path = skillTargetsPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseSkillTargets(readFileSync(path, 'utf-8'));
    return parsed ? parsed.targets : null;
  } catch (err) {
    logger.warn({ err, path }, 'skill-targets store unreadable');
    return null;
  }
}

export async function writeSkillTargets(
  projectDir: string,
  targets: SkillTargetEditor[],
): Promise<void> {
  const deduped = Array.from(new Set(targets));
  const parsed = SkillTargetsSchema.safeParse({
    schema: SKILL_TARGETS_SCHEMA_VERSION,
    targets: deduped,
  });
  if (!parsed.success) {
    throw new Error(
      `Refusing to write invalid skill-targets: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const path = skillTargetsPath(projectDir);
  await tracedMkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    fs: tracedAtomicFs,
  });
}
