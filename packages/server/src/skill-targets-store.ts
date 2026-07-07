/**
 * Read/write the per-project skill-targets store at
 * `<projectDir>/.ok/skill-targets.json` — the COMMITTED, editable set of editor
 * host dirs OK projects skills into (teammates inherit it). `null` from the
 * reader means "no committed targets" → callers fall back to detecting the
 * editors the project is configured for.
 *
 * Atomic write through the traced fs primitives. Schema + parse live in core
 * so any reader (CLI, future surfaces) validates identically.
 */

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

/** Absolute path to the committed skill-targets store for a project. */
export function skillTargetsPath(projectDir: string): string {
  return join(projectDir, ...SKILL_TARGETS_REL);
}

/**
 * Read the committed target editor ids. Returns `null` when the store is
 * absent or corrupt (fail-soft) — callers then fall back to detecting the
 * project-configured editors.
 */
export function readSkillTargets(projectDir: string): SkillTargetEditor[] | null {
  const path = skillTargetsPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = parseSkillTargets(readFileSync(path, 'utf-8'));
    return parsed ? parsed.targets : null;
  } catch (err) {
    // Fail-soft to detection, but surface the corrupt committed file — silent
    // null masks why teammates' configured targets stopped applying.
    logger.warn({ err, path }, 'skill-targets store unreadable');
    return null;
  }
}

/** Validate then atomically write the committed skill-targets store. */
export async function writeSkillTargets(
  projectDir: string,
  targets: SkillTargetEditor[],
): Promise<void> {
  // De-dupe while preserving order so the committed file is stable.
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
