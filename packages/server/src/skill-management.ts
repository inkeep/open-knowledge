/**
 * Read/write the per-project skill-management marker at
 * `<projectDir>/.ok/local/skill-management.json`.
 *
 * `manageEditorSkills: true` ⇒ the project is OK-managed: `reconcileSkillInstalls`
 * ADOPTS non-`.ok` editor-dir skills into `.ok/skills` (the opt-in bulk import +
 * ongoing auto-adopt of newly-installed editor skills). Absent / `false` (the
 * default) ⇒ OK never imports a non-`.ok` skill. Management of skills that ALREADY
 * have a `.ok/skills/<name>` entry is independent of this flag — those are always
 * managed (heal/orphan/collapse/project; see `skill-reconcile.ts`).
 *
 * Per-machine runtime state under `.ok/local/` (gitignored), sibling to
 * `installed-skills.json` — a collaborator's choice never dirties the shared
 * tracked tree. Atomic tmp+rename through the traced fs primitives; fail-soft read
 * (absent / corrupt → unset, never a hard error).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from '@inkeep/open-knowledge-core/server';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { getLogger } from './logger.ts';

const logger = getLogger('skill-management');

/** Project-relative path segments. Sibling of `INSTALLED_SKILLS_REL`. */
const SKILL_MANAGEMENT_REL = ['.ok', 'local', 'skill-management.json'] as const;
const SCHEMA_VERSION = 1;

/** Routes core's atomic write through the server's traced fs primitives. */
export interface SkillManagement {
  version: number;
  /** When true the project is OK-managed — reconcile adopts non-`.ok` editor skills. */
  manageEditorSkills: boolean;
  /** ISO timestamp the decision was recorded (diagnostic). */
  decidedAt?: string;
  /** Which surface recorded it: "desktop" | "ui" | "cli" (diagnostic). */
  surface?: string;
}

/** Absolute path to the marker for a project. */
export function skillManagementPath(projectDir: string): string {
  return join(projectDir, ...SKILL_MANAGEMENT_REL);
}

/**
 * Read the marker. Fail-soft: absent / corrupt / wrong-shape → `null` (unset),
 * never throws — an unreadable marker means "no decision recorded", which the
 * default-off gate treats as "do not adopt".
 */
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

/** Atomically record the project's skill-management decision. */
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

/**
 * Is the project OK-managed — i.e. may reconcile ADOPT non-`.ok` editor skills?
 * Precedence (first match wins):
 *   1. `OK_RECLAIM_DISABLE=1`   → false (global kill-switch; also gates the
 *                                  always-on paths at their own call sites).
 *   2. `OK_SKILL_MANAGE=1|true` → true · `=0|false` → false (process-scoped
 *                                  override; never written to disk).
 *   3. recorded marker          → its `manageEditorSkills`.
 *   4. else                     → false (default: do not adopt).
 *
 * This gates ONLY adoption of non-`.ok` skills. Skills with a `.ok/skills/<name>`
 * entry are managed regardless.
 */
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
