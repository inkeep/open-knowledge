/**
 * Edit-a-skill-without-managing — the guarded external-write core.
 *
 * A detected (unmanaged) skill lives OUTSIDE the project's `contentDir`, at a
 * harness-specific dir that can't be reconstructed from its name alone
 * (`~/.claude/skills/<name>`, `~/.codex/skills/<name>`,
 * `~/.claude/plugins/<plugin>/skills/<name>`, …). To edit it in place, the app
 * registers the real enumerated dir (`CatalogSkill.home`) when opening the skill,
 * and persistence resolves + writes through here.
 *
 * DATA-SAFETY (the one place OK writes a user's LIVE harness skill): every
 * resolved path is containment-checked to the registered skill dir. A malformed
 * name / rel can never escape it — mirrors the guards in `managedArtifactAbsPath`.
 *
 * The registry is per-server-process, in memory (an editable unmanaged skill is a
 * transient editing session; nothing to persist). Registration is keyed by the
 * skill NAME because detected skills are de-duped by name in the catalog.
 */

import { resolve, sep } from 'node:path';
import { SKILL_NAME_REGEX } from '@inkeep/open-knowledge-core';

/** skill name → absolute, realpath'd skill dir the caller enumerated (`home`). */
const registry = new Map<string, string>();

/** Register (or refresh) the real on-disk dir for an editable unmanaged skill.
 *  `absSkillDir` MUST already be realpath-resolved by the caller. */
export function registerExternalSkill(name: string, absSkillDir: string): void {
  registry.set(name, absSkillDir);
}

/** Drop a skill's registration (on tab close / Manage handoff). */
export function unregisterExternalSkill(name: string): void {
  registry.delete(name);
}

/** The registered dir for a skill, or null when not an editable-unmanaged skill. */
export function externalSkillDir(name: string): string | null {
  return registry.get(name) ?? null;
}

/**
 * Absolute on-disk path for an external skill doc's `SKILL.md` (`rel === null`)
 * or a bundle file (`rel`, a `/`-joined ext-less path like `references/setup`).
 * Returns null when the skill isn't registered (→ caller falls through to the
 * normal managed-artifact path). THROWS on any name/rel that would escape the
 * registered dir — the containment gate.
 */
export function externalSkillAbsPath(name: string, rel: string | null): string | null {
  const dir = registry.get(name);
  if (dir === undefined) return null;
  // Guard 1: slug grammar (rejects `..`, slashes, dots, uppercase, empty, >64).
  if (!SKILL_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(`externalSkillAbsPath: invalid skill name ${JSON.stringify(name)}`);
  }
  let abs: string;
  if (rel === null) {
    abs = resolve(dir, 'SKILL.md');
  } else {
    const segs = rel.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0 || segs.some((s) => s === '..')) {
      throw new Error(`externalSkillAbsPath: invalid bundle path ${JSON.stringify(rel)}`);
    }
    abs = resolve(dir, ...segs);
  }
  // Guard 2: containment on the resolved path (defense-in-depth; `SKILL.md` and
  // every bundle file resolve under `dir + sep`). Fires only if guard 1 is ever
  // weakened. Mirrors `managedArtifactAbsPath` guard 2.
  if (!abs.startsWith(dir + sep)) {
    throw new Error(`externalSkillAbsPath: path escape for ${JSON.stringify(name)}`);
  }
  return abs;
}
