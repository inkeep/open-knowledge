
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { getLogger } from './logger.ts';

const logger = getLogger('skill-management');

const SKILL_MANAGEMENT_REL = ['.ok', 'local', 'skill-management.json'] as const;
const SCHEMA_VERSION = 1;

export interface SkillManagement {
  version: number;
  manageEditorSkills: boolean;
  decidedAt?: string;
  surface?: string;
}

export function skillManagementPath(projectDir: string): string {
  return join(projectDir, ...SKILL_MANAGEMENT_REL);
}

export function readSkillManagement(projectDir: string): SkillManagement | null {
  const path = skillManagementPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { manageEditorSkills?: unknown }).manageEditorSkills === 'boolean'
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        version: typeof p.version === 'number' ? p.version : SCHEMA_VERSION,
        manageEditorSkills: p.manageEditorSkills as boolean,
        decidedAt: typeof p.decidedAt === 'string' ? p.decidedAt : undefined,
        surface: typeof p.surface === 'string' ? p.surface : undefined,
      };
    }
    logger.warn({ path }, 'skill-management marker malformed — treating as unset');
    return null;
  } catch (err) {
    logger.warn({ err, path }, 'skill-management marker unreadable — treating as unset');
    return null;
  }
}

export async function writeSkillManagement(
  projectDir: string,
  opts: { manageEditorSkills: boolean; surface?: string; now?: string },
): Promise<void> {
  const doc: SkillManagement = {
    version: SCHEMA_VERSION,
    manageEditorSkills: opts.manageEditorSkills,
    decidedAt: opts.now ?? new Date().toISOString(),
    ...(opts.surface ? { surface: opts.surface } : {}),
  };
  const path = skillManagementPath(projectDir);
  await tracedMkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(doc, null, 2)}\n`, { fs: tracedAtomicFs });
}

export function isProjectSkillManaged(
  projectDir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OK_RECLAIM_DISABLE === '1') return false;
  const forced = env.OK_SKILL_MANAGE;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  return readSkillManagement(projectDir)?.manageEditorSkills ?? false;
}
