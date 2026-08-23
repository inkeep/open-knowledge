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
import {
  OPENKNOWLEDGE_SKILLS_REPO,
  PACK_SKILL_PREFIX,
  RENAMED_PACK_SKILLS,
} from '../../constants/skills.ts';

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

/** The published pack-skill names — the post-rename half of the retrofit gate. */
const RENAMED_PACK_SKILL_NAMES: ReadonlySet<string> = new Set(Object.values(RENAMED_PACK_SKILLS));

/**
 * The upstream `metadata.pack` marker in an acquired SKILL.md, when it has one.
 *
 * The write canonicalizes frontmatter, and this is the single key that has to
 * survive it: it is the only proof that a generically-named skill (`write-a-spec`,
 * `knowledge-base`) is a starter pack of ours rather than the user's own work,
 * and {@link retrofitPackLockEntry} refuses to synthesize provenance without it.
 */
export function packMarkerOf(frontmatter: unknown): string | undefined {
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined;
  const metadata = (frontmatter as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const pack = (metadata as { pack?: unknown }).pack;
  return typeof pack === 'string' && pack.trim().length > 0 ? pack.trim() : undefined;
}

/**
 * Retrofit provenance for a seeded starter pack whose lock entry is missing.
 * A pack skill with no lock entry cannot update, but every pack ships from
 * OPENKNOWLEDGE_SKILLS_REPO — a deterministic upstream — so synthesize the entry
 * from the installed `contentHash` and let it update through the normal reimport
 * path. An unchanged upstream is then a correct no-op (installed hash ===
 * acquired hash).
 *
 * Accepts BOTH naming eras. Gating on the old prefix alone was right only while
 * every pack skill carried it; post-rename a fresh install is short-named, and a
 * short-named install that loses its lock entry — best-effort provenance write
 * failed, or a teammate cloned `.claude/skills/` without the gitignored lock —
 * had no way back and answered Update with a flat "no recorded import source".
 * Returns null for any name that is not a pack skill.
 */
export function retrofitPackLockEntry(
  name: string,
  installedContentHash: string,
  importedAt: string,
  opts?: {
    /**
     * Does the installed bundle carry this pack's `metadata.pack` marker? Only
     * consulted for the post-rename short names, which are generic enough that a
     * user may own one; the old prefixed names need no witness.
     */
    selfIdentifiesAsPack?: boolean;
  },
): SkillLockEntry | null {
  if (name.startsWith(PACK_SKILL_PREFIX)) {
    // Namespaced: nobody else's skill can hold this name, so presence is proof.
    return packEntry(name, installedContentHash, importedAt);
  }
  // A published short name like `write-a-spec` or `knowledge-base` is generic —
  // a user can easily have authored their own. Presence alone is NOT proof, and
  // synthesizing our provenance onto their skill would offer to overwrite it
  // with ours on the next Update. Require the bundle to self-identify as this
  // pack's, the same witness `classifyPresentPackSkill` uses before treating a
  // present skill as ours.
  if (!RENAMED_PACK_SKILL_NAMES.has(name) || opts?.selfIdentifiesAsPack !== true) return null;
  return packEntry(name, installedContentHash, importedAt);
}

function packEntry(name: string, contentHash: string, importedAt: string): SkillLockEntry {
  return {
    source: OPENKNOWLEDGE_SKILLS_REPO,
    skill: name,
    contentHash,
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
