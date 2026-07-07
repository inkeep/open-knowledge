#!/usr/bin/env bun
/**
 * Shared-content composer for the two OK skill bundles
 *
 * Source of truth (git-tracked):
 *   packages/server/assets/skills/discovery/SKILL.md
 *   packages/server/assets/skills/project/SKILL.md
 *   packages/server/assets/skills/_shared/<name>.md   — prose used by ≥2 bundles
 *
 * Source SKILL.md files MAY contain `{{> _shared/<name>.md }}` placeholders.
 * This build step resolves each placeholder against `_shared/` and writes the
 * composed result to a gitignored dist location:
 *
 *   packages/server/dist/assets/skills/<bundle>/SKILL.md
 *
 * `resolveBundledSkillDir()` probes that dist path before the source path, so
 * the composed (placeholder-free) bundle is what gets installed. At v1
 * `_shared/` carries no shared prose yet — neither bundle references a
 * placeholder, so composition is an identity transform — but the mechanism +
 * the CI byte-equality guard exist now so shared prose can land without drift
 * the moment two bundles overlap.
 *
 * Build-time, NOT runtime: composing at runtime would add install-time
 * complexity; this matches the standard build-step include pattern.
 *
 * Usage:
 *   bun packages/server/scripts/build-skill-bundles.ts            # compose → dist
 *   bun packages/server/scripts/build-skill-bundles.ts --check    # CI guard, no writes
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_IDS, type BundleId } from '../src/skill-bundles.ts';

// Re-export the canonical bundle-id list (single source: `skill-bundles.ts`) so
// existing consumers that import `BUNDLE_IDS` from this script keep working. The
// composer builds EVERY id in this set — adding a bundle in `skill-bundles.ts`
// now flows into the dist composition automatically, instead of the old
// hand-maintained literal here that silently omitted `write-skill`.
export { BUNDLE_IDS };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

/** Default on-disk layout. Overridable so unit tests can point at a fixture. */
export interface SkillBundlePaths {
  /** Directory holding `<bundle>/SKILL.md` + `_shared/`. */
  readonly skillsDir: string;
  /** Directory the composed `<bundle>/SKILL.md` files are written under. */
  readonly distDir: string;
}

export function defaultPaths(): SkillBundlePaths {
  return {
    skillsDir: join(PKG_ROOT, 'assets', 'skills'),
    distDir: join(PKG_ROOT, 'dist', 'assets', 'skills'),
  };
}

/**
 * The ONLY supported placeholder form (no conditional
 * includes, no variable substitution): `{{> _shared/<name>.md }}`. `<name>`
 * is a single path segment (the `.md` is part of the captured name).
 */
const PLACEHOLDER_RE = /\{\{>\s*_shared\/([A-Za-z0-9._-]+)\s*\}\}/g;

/**
 * Resolve every `{{> _shared/<name>.md }}` placeholder in `source` via the
 * `resolveShared` callback. Pure — no fs — so it is trivially unit-testable.
 * Returns the composed text plus the de-duplicated list of placeholder names
 * referenced (in first-seen order).
 */
export function composeSkill(
  source: string,
  resolveShared: (name: string) => string,
): { composed: string; placeholders: string[] } {
  const placeholders: string[] = [];
  const composed = source.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!placeholders.includes(name)) placeholders.push(name);
    return resolveShared(name);
  });
  return { composed, placeholders };
}

function sharedResolver(skillsDir: string): (name: string) => string {
  const sharedDir = join(skillsDir, '_shared');
  return (name: string) => {
    const sharedPath = join(sharedDir, name);
    if (!existsSync(sharedPath)) {
      throw new Error(
        `Skill bundle references {{> _shared/${name} }} but ${sharedPath} does not exist.`,
      );
    }
    return readFileSync(sharedPath, 'utf-8');
  };
}

interface ComposedBundle {
  readonly bundle: BundleId;
  /** Composed (placeholder-free) SKILL.md text. */
  readonly composed: string;
  /** Placeholder names this bundle referenced. */
  readonly placeholders: string[];
  /** Where the composed file was (or would be) written. */
  readonly outputPath: string;
}

/**
 * Compose every bundle and write the result to `distDir/<bundle>/SKILL.md`.
 * Returns one entry per bundle. The dist tree is wiped + recreated so a
 * removed source file never leaves a stale composed artifact behind.
 */
export function buildSkillBundles(paths: SkillBundlePaths = defaultPaths()): ComposedBundle[] {
  const resolve = sharedResolver(paths.skillsDir);
  const results: ComposedBundle[] = [];
  for (const bundle of BUNDLE_IDS) {
    const sourceDir = join(paths.skillsDir, bundle);
    const source = readFileSync(join(sourceDir, 'SKILL.md'), 'utf-8');
    const { composed, placeholders } = composeSkill(source, resolve);
    const outDir = join(paths.distDir, bundle);
    const outputPath = join(outDir, 'SKILL.md');
    rmSync(outDir, { recursive: true, force: true });
    // Copy the ENTIRE source bundle dir (references/, scripts/, …) so the
    // shipped bundle is complete, THEN overwrite SKILL.md with the composed
    // (placeholder-resolved) text. Without the dir copy the composer emitted
    // only SKILL.md, so a bundle's references never reached published / desktop
    // builds — `resolveBundledSkillDir` prefers dist, which would carry no refs.
    cpSync(sourceDir, outDir, { recursive: true });
    writeFileSync(outputPath, composed, 'utf-8');
    results.push({ bundle, composed, placeholders, outputPath });
  }
  return results;
}

/**
 * Compose every per-pack skill (`packs/<id>/SKILL.md`) into the dist tree the
 * same way the named bundles are composed. Pack skills carry no `_shared`
 * placeholders today, so composition is an identity transform — but routing
 * them through `composeSkill` keeps them on the same mechanism, and (critically)
 * gets them INTO `dist/assets/skills/packs/<id>/` so the published CLI + desktop
 * bundles actually ship them. Without this, `resolveBundledSkillDir('packs/<id>')`
 * only resolves against the source tree (dev), and `ok seed`'s pack-skill
 * install silently no-ops in any built artifact. Returns the pack ids built.
 */
export function buildPackSkills(paths: SkillBundlePaths = defaultPaths()): string[] {
  const packsSrc = join(paths.skillsDir, 'packs');
  if (!existsSync(packsSrc)) return [];
  const resolve = sharedResolver(paths.skillsDir);
  const built: string[] = [];
  for (const entry of readdirSync(packsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(packsSrc, entry.name);
    const sourcePath = join(sourceDir, 'SKILL.md');
    if (!existsSync(sourcePath)) continue;
    const { composed } = composeSkill(readFileSync(sourcePath, 'utf-8'), resolve);
    const outDir = join(paths.distDir, 'packs', entry.name);
    const outputPath = join(outDir, 'SKILL.md');
    rmSync(outDir, { recursive: true, force: true });
    // Copy the full pack dir (seed content + any references) then overwrite the
    // composed SKILL.md — same completeness rule as the named bundles.
    cpSync(sourceDir, outDir, { recursive: true });
    writeFileSync(outputPath, composed, 'utf-8');
    built.push(entry.name);
  }
  return built;
}

interface ByteEqualityResult {
  readonly ok: boolean;
  readonly violations: string[];
}

/**
 * CI byte-equality guard. For every `{{> _shared/<name>.md }}`
 * placeholder referenced by any bundle, assert (a) the `_shared/<name>` file
 * exists and (b) the composed output of EVERY referencing bundle contains the
 * shared file's exact bytes. Because all bundles resolve the same `_shared/`
 * file, "byte-identical content across bundles" reduces to: every referencing
 * bundle's composed output embeds that one file verbatim.
 *
 * No fs writes — recomposes in memory. At v1 (`_shared/` empty, no
 * placeholders) this passes trivially.
 */
export function checkSharedContentByteEquality(
  paths: SkillBundlePaths = defaultPaths(),
): ByteEqualityResult {
  const violations: string[] = [];
  const sharedDir = join(paths.skillsDir, '_shared');
  const sharedCache = new Map<string, string>();
  const readShared = (name: string): string => {
    const cached = sharedCache.get(name);
    if (cached !== undefined) return cached;
    const text = readFileSync(join(sharedDir, name), 'utf-8');
    sharedCache.set(name, text);
    return text;
  };

  const composed = new Map<BundleId, { text: string; placeholders: string[] }>();
  for (const bundle of BUNDLE_IDS) {
    const source = readFileSync(join(paths.skillsDir, bundle, 'SKILL.md'), 'utf-8');
    // Collect placeholders without resolving — a missing file is reported as a
    // violation rather than thrown, so the guard surfaces every problem at once.
    const placeholders: string[] = [];
    composeSkill(source, (name) => {
      if (!placeholders.includes(name)) placeholders.push(name);
      return '';
    });
    for (const name of placeholders) {
      if (!existsSync(join(sharedDir, name))) {
        violations.push(`bundle '${bundle}' references {{> _shared/${name} }} — file is missing`);
      }
    }
    composed.set(bundle, { text: '', placeholders });
  }

  // Second pass: now that missing-file violations are recorded, recompose the
  // bundles whose placeholders all resolve and assert the embedded bytes.
  for (const bundle of BUNDLE_IDS) {
    const entry = composed.get(bundle);
    if (!entry) continue;
    const resolvable = entry.placeholders.every((name) => existsSync(join(sharedDir, name)));
    if (!resolvable) continue;
    const source = readFileSync(join(paths.skillsDir, bundle, 'SKILL.md'), 'utf-8');
    const { composed: text } = composeSkill(source, readShared);
    for (const name of entry.placeholders) {
      if (!text.includes(readShared(name))) {
        violations.push(
          `bundle '${bundle}' composed output is not byte-identical to _shared/${name}`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  if (check) {
    const result = checkSharedContentByteEquality();
    if (!result.ok) {
      console.error('[build-skill-bundles] shared-content byte-equality check FAILED:');
      for (const v of result.violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log('[build-skill-bundles] shared-content byte-equality check passed.');
  } else {
    const built = buildSkillBundles();
    for (const b of built) {
      const note =
        b.placeholders.length > 0
          ? ` (resolved ${b.placeholders.length} placeholder(s): ${b.placeholders.join(', ')})`
          : ' (no placeholders)';
      console.log(`[build-skill-bundles] composed ${b.bundle} → ${b.outputPath}${note}`);
    }
    const packs = buildPackSkills();
    if (packs.length > 0) {
      console.log(
        `[build-skill-bundles] composed ${packs.length} pack skill(s): ${packs.join(', ')}`,
      );
    }
  }
}
