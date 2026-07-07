/**
 * Starter-pack skill version + update-detection helpers.
 *
 * A starter-pack skill (`open-knowledge-pack-<id>`) is installed once as
 * editable content, then never refreshed. To surface an opt-in "update
 * available" signal we compare the `version` frontmatter of the user's installed
 * copy against the version OK currently bundles. Pure detection — never writes;
 * the update itself is the `/api/skill/update` handler.
 *
 * Single owner for: the pack-name predicate, reading a SKILL.md `version`, the
 * bundled-version lookup, and the staleness verdict. Reuses existing single
 * sources — `PACK_SKILL_PREFIX` (skill-projection), `compareSemver`
 * (git-preflight), `resolveBundledSkillDir` (build-skill-zip), and core's
 * frontmatter primitives — rather than re-deriving any of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFrontmatterYaml,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { resolveBundledSkillDir } from './build-skill-zip.ts';
import { compareSemver } from './git-preflight.ts';
import { PACK_SKILL_PREFIX } from './skill-projection.ts';

/** True for the reserved starter-pack skill names (`open-knowledge-pack-*`). */
export function isPackSkillName(name: string): boolean {
  return name.startsWith(PACK_SKILL_PREFIX);
}

/** The pack id embedded in a pack skill name, or `null` for non-pack names. */
export function packIdFromSkillName(name: string): string | null {
  return isPackSkillName(name) ? name.slice(PACK_SKILL_PREFIX.length) : null;
}

/**
 * Read the `version` frontmatter scalar from raw SKILL.md text. Returns
 * `undefined` when absent, non-string, or the frontmatter is malformed — same
 * lenient parse the skills-list enumeration uses (core primitives, not a 4th
 * bespoke parser).
 */
export function readSkillVersion(raw: string): string | undefined {
  const { frontmatter: fenced } = stripFrontmatter(raw);
  if (fenced === '') return undefined;
  const { map } = parseFrontmatterYaml(unwrapFrontmatterFences(fenced));
  const version = map?.version;
  return typeof version === 'string' && version.trim() !== '' ? version : undefined;
}

/**
 * Resolve the SERVER's own bundled pack skill dir (`checkDesktop:false` — this
 * server updates from the bundle it itself ships, deterministically; the seed's
 * desktop-prefers behavior is a separate CLI concern). `null` for non-pack names
 * or a pack that ships no skill. Reuses the lower-level `resolveBundledSkillDir`
 * single source (which throws when missing — caught here).
 */
function bundledPackSkillDir(name: string): string | null {
  const packId = packIdFromSkillName(name);
  if (packId === null) return null;
  try {
    return resolveBundledSkillDir(`packs/${packId}`, { checkDesktop: false });
  } catch {
    return null;
  }
}

/**
 * The `version` OK currently bundles for a pack skill, or `undefined` when the
 * name isn't a pack, the pack ships no skill, or its SKILL.md carries no version.
 */
export function bundledPackVersion(name: string): string | undefined {
  const dir = bundledPackSkillDir(name);
  if (dir === null) return undefined;
  try {
    return readSkillVersion(readFileSync(join(dir, 'SKILL.md'), 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * Read OK's currently-bundled SKILL.md for a pack skill — the verbatim content
 * an update writes, plus its version. Returns `null` when the name isn't a pack
 * or the pack ships no skill source. Content is written verbatim (preserving the
 * bundled `version` + all frontmatter), so the update never recomposes.
 */
export function readBundledPackSkill(
  name: string,
): { content: string; version: string | undefined } | null {
  const dir = bundledPackSkillDir(name);
  if (dir === null) return null;
  let content: string;
  try {
    content = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
  return { content, version: readSkillVersion(content) };
}

/**
 * Pure verdict (no disk): is `bundledVersion` newer than the installed copy? A
 * missing/unparseable installed `version` is treated as v0 (a versionless copy
 * is pre-versioning legacy → surface the update, never silently overwrite).
 * Strictly-greater only — never offer a "downgrade".
 */
export function packUpdateAvailable(
  installedVersion: string | undefined,
  bundledVersion: string,
): boolean {
  return installedVersion === undefined
    ? true
    : compareSemver(bundledVersion, installedVersion) > 0;
}

/**
 * Staleness verdict for one installed skill. Returns the bundled version and an
 * `updateAvailable` flag, or an empty object for non-pack skills / packs with no
 * bundled version (so the schema fields stay absent and only packs get badged).
 * The verdict drives a *suggestion* only; it is never trusted for a silent write.
 */
export function computePackUpdateStatus(
  name: string,
  installedVersion: string | undefined,
): { bundledVersion?: string; updateAvailable?: boolean } {
  const bundledVersion = bundledPackVersion(name);
  if (bundledVersion === undefined) return {};
  return { bundledVersion, updateAvailable: packUpdateAvailable(installedVersion, bundledVersion) };
}
