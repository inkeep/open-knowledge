/**
 * Single source of truth for OK's shipped skill bundles.
 *
 * A "bundle" is a skill OK ships under `packages/server/assets/skills/<id>/`,
 * whose `id` doubles as the source-dir name (so `resolveBundledSkillDir(id)`
 * resolves `assets/skills/<id>`). Each bundle's frontmatter `name:` is its
 * install dir name in editor host dirs.
 *
 * Kept dependency-free on purpose: it's imported by `build-skill-zip.ts` AND
 * read by the release version-sync (`scripts/sync-skill-version.sh` derives its
 * file list from `BUNDLE_IDS` via `bun`), so the bundle set is declared ONCE.
 * Adding a bundle here flows to the copier, the version-sync, and any drift
 * check — no hand-maintained parallel lists.
 */

/** Which skill bundle to resolve / build. */
export type BundleId = 'discovery' | 'project' | 'write-skill';

/**
 * Frontmatter `name:` each bundle must carry — also its install dir name. The
 * `discovery` + `write-skill` bundles take distinct names so a global-scope
 * skill named `open-knowledge` can't SHADOW the rich project bundle (Anthropic
 * same-name hierarchy is enterprise > global > project). Reserved
 * `open-knowledge*` prefixes keep authored skills from shadowing built-ins.
 */
export const BUNDLE_SKILL_NAME: Record<BundleId, string> = {
  discovery: 'open-knowledge-discovery',
  project: 'open-knowledge',
  'write-skill': 'open-knowledge-write-skill',
};

/** Canonical ordered bundle id list (= the keys of `BUNDLE_SKILL_NAME`). */
export const BUNDLE_IDS = Object.keys(BUNDLE_SKILL_NAME) as BundleId[];

/**
 * Install scope per bundle:
 *   - `user` — force-installed user-global (`~/.{host}/skills/<name>/`), so it's
 *     present in EVERY project. Reclaimed on launch by both the desktop
 *     (`reclaimUserSkillsOnLaunch`) and the CLI (`runUserSweep`).
 *   - `project` — installed into a project's editor dirs at init / reclaim.
 */
export const BUNDLE_SCOPE: Record<BundleId, 'user' | 'project'> = {
  discovery: 'user',
  project: 'project',
  'write-skill': 'user',
};

/**
 * The user-global built-in bundles, derived from `BUNDLE_SCOPE`. The two
 * user-global reclaim paths (desktop + CLI) loop over this set so adding a
 * user-global built-in here installs it everywhere — no per-path list to drift.
 */
export const USER_GLOBAL_BUNDLE_IDS = BUNDLE_IDS.filter((id) => BUNDLE_SCOPE[id] === 'user');

/**
 * Repo-relative path of a bundle's `SKILL.md` (the file whose
 * `metadata.version` the release sync bumps). Derived from the id, which equals
 * the source-dir name.
 */
export function bundleSkillMdPath(id: BundleId): string {
  return `packages/server/assets/skills/${id}/SKILL.md`;
}
