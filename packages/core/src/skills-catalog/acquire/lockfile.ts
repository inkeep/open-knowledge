/**
 * The import lockfile schema + pure transforms — the "tracking" half of import.
 *
 * `<project>/.ok/skills-lock.json` records WHERE each imported skill came from,
 * separate from the skill content and from the per-machine installed-skills
 * symlink marker. It is committed, so a teammate's `update` re-pulls from the
 * same upstream. Disk I/O lives in the server (fs-traced); this module is the
 * schema + pure helpers so both sides validate identically.
 */

import { z } from 'zod';
import { OK_DIR } from '../../constants/ok-dir.ts';
import { OPENKNOWLEDGE_SKILLS_REPO, PACK_SKILL_PREFIX } from '../../constants/skills.ts';

/** Filename of the committed import lockfile under `.ok/`. */
export const SKILLS_LOCK_FILENAME = 'skills-lock.json';

/** Path segments relative to the project root (committed, NOT under `local/`). */
export const SKILLS_LOCK_REL = [OK_DIR, SKILLS_LOCK_FILENAME] as const;

/** Schema major version. Bump on breaking shape changes with a migrator. */
export const SKILLS_LOCK_SCHEMA_VERSION = 1;

/** One imported skill's upstream record. `looseObject` for forward-compat. */
export const SkillLockEntrySchema = z.looseObject({
  /** The raw source the user imported from (url / shorthand / path / `adopt:<harness>`). */
  source: z.string(),
  /** Owning plugin adapter. Persisted so future providers never reinterpret source paths. */
  pluginProvider: z.string().optional(),
  /** Picked upstream skill dir basename (multi-skill sources) — reimport re-selects it. */
  skill: z.string().optional(),
  /** Resolved commit sha when the source was a git clone. */
  ref: z.string().optional(),
  /** sha256 over the UPSTREAM bundle as fetched — integrity + dedupe key. */
  contentHash: z.string(),
  /** Bundle-file paths present in that upstream snapshot (excludes SKILL.md).
   * Reimport uses this manifest to prune files removed upstream without
   * mistaking a later user-authored local file for upstream residue. */
  files: z.array(z.string()).optional(),
  /**
   * sha256 over the skill AS WRITTEN LOCALLY at install/reimport time — the
   * mutation baseline. Differs from `contentHash` because the write canonicalizes
   * frontmatter to `{name,description}`; comparing the current on-disk hash to
   * `contentHash` would flag every freshly-installed skill as modified. Optional:
   * lockfiles written before this field can't detect mutation (treated as clean).
   */
  localHash: z.string().optional(),
  /**
   * Shadow-repo commit the skill was written at on install/reimport — the Revert
   * target ("restore the version I installed"). Restored via the same engine as
   * skill version-history restore. Optional: entries written before this field
   * can't be reverted (the UI hides Revert when absent).
   */
  baselineRef: z.string().optional(),
  publisher: z.string().optional(),
  importedAt: z.iso.datetime(),
  /** Explicit per-skill auto-update choice; absent uses the source-kind default. */
  autoUpdate: z.boolean().optional(),
});
export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>;

/** Top-level lockfile shape; `skills` keyed by the on-disk skill name. */
export const SkillsLockSchema = z.looseObject({
  schema: z.literal(SKILLS_LOCK_SCHEMA_VERSION),
  skills: z.record(z.string(), SkillLockEntrySchema).default({}),
});
export type SkillsLock = z.infer<typeof SkillsLockSchema>;

/** A fresh, empty lockfile at the current schema version. */
export function emptySkillsLock(): SkillsLock {
  return { schema: SKILLS_LOCK_SCHEMA_VERSION, skills: {} };
}

/**
 * Parse + validate raw lockfile JSON. Returns `null` on parse error or schema
 * violation (fail-soft — a corrupt lockfile is treated as "nothing imported"
 * rather than throwing, so a bad file never breaks an import).
 */
export function parseSkillsLock(raw: string): SkillsLock | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = SkillsLockSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Pure: return a new lockfile with `name`'s entry set to `entry`. */
export function upsertLockEntry(lock: SkillsLock, name: string, entry: SkillLockEntry): SkillsLock {
  return { ...lock, skills: { ...lock.skills, [name]: entry } };
}

/**
 * Retrofit provenance for a seeded starter pack that predates lockfile recording.
 * A `open-knowledge-pack-*` skill installed before provenance existed has no lock
 * entry, but every pack ships from OPENKNOWLEDGE_SKILLS_REPO — a deterministic
 * upstream — so synthesize the entry from the installed `contentHash` and let it
 * update through the normal reimport path. An unchanged upstream is then a correct
 * no-op (installed hash === acquired hash). Returns null for any non-pack name.
 */
export function retrofitPackLockEntry(
  name: string,
  installedContentHash: string,
  importedAt: string,
): SkillLockEntry | null {
  if (!name.startsWith(PACK_SKILL_PREFIX)) return null;
  return {
    source: OPENKNOWLEDGE_SKILLS_REPO,
    skill: name,
    contentHash: installedContentHash,
    importedAt,
  };
}

/**
 * Is a skill with this `contentHash` already recorded? The "already have it"
 * dedupe signal — the same bytes imported before need not be re-fetched.
 */
export function findByContentHash(lock: SkillsLock, contentHash: string): string | null {
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.contentHash === contentHash) return name;
  }
  return null;
}
