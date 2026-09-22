#!/usr/bin/env -S npx tsx
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
 * the byte-equality guard exist now so shared prose can land without drift
 * the moment two bundles overlap.
 *
 * Build-time, NOT runtime: composing at runtime would add install-time
 * complexity; this matches the standard build-step include pattern.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_IDS, BUNDLE_SKILL_NAME, type BundleId } from '../src/skill-bundles.ts';
import { enumeratePackSkills } from '../src/skill-pack-sources.ts';

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

const REMOVAL_RETRIES = 3;

const STAGING_ROOT_PREFIX = '.ok-skill-publish-';

const KEPT_TREE_PREFIX = `${STAGING_ROOT_PREFIX}kept-`;

const STALE_STAGING_AGE_MS = 30_000;

const DESTINATION_OCCUPIED_CODES = new Set(['ENOTEMPTY', 'EEXIST']);

function discardTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: REMOVAL_RETRIES });
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    console.warn(`[build-skill-bundles] could not remove ${path}: ${reason}`);
  }
}

function reinstateTree(superseded: string, dest: string): boolean {
  try {
    renameSync(superseded, dest);
    return true;
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    console.error(
      `[build-skill-bundles] could not reinstate ${dest} from ${superseded}: ${reason}`,
    );
    return false;
  }
}

function destinationIsPublished(dest: string): boolean {
  try {
    return readdirSync(dest).length > 0;
  } catch {
    return false;
  }
}

function peerPublished(dest: string, err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && DESTINATION_OCCUPIED_CODES.has(code)) return true;
  return destinationIsPublished(dest);
}

function stagingParentFor(distDir: string): string {
  let current = distDir;
  while (current !== dirname(current)) {
    if (basename(current) === 'dist') return dirname(current);
    current = dirname(current);
  }
  return dirname(distDir);
}

type TreeInspection =
  | { readonly ok: true; readonly newest: number }
  | { readonly ok: false; readonly failed: string };

function inspectTree(path: string): TreeInspection {
  let newest = 0;
  let failed: string | null = null;
  const visit = (current: string): void => {
    if (failed !== null) return;
    let isDirectory: boolean;
    try {
      const entry = lstatSync(current);
      if (entry.mtimeMs > newest) newest = entry.mtimeMs;
      isDirectory = entry.isDirectory();
    } catch (err) {
      failed = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return;
    }
    if (!isDirectory) return;
    let children: string[];
    try {
      children = readdirSync(current);
    } catch (err) {
      failed = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return;
    }
    for (const child of children) visit(join(current, child));
  };
  visit(path);
  return failed === null ? { ok: true, newest } : { ok: false, failed };
}

function keepDisplacedTree(holder: string): { readonly kept: boolean; readonly root: string } {
  const kept = join(
    dirname(holder),
    `${KEPT_TREE_PREFIX}${basename(holder).slice(STAGING_ROOT_PREFIX.length)}`,
  );
  try {
    renameSync(holder, kept);
    return { kept: true, root: kept };
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    console.error(
      `[build-skill-bundles] could not move ${holder} out of reclaimable scratch: ${reason}`,
    );
    return { kept: false, root: holder };
  }
}

const sweepNotices = new Set<string>();

function noticeOnce(path: string, note: string): void {
  if (sweepNotices.has(path)) return;
  sweepNotices.add(path);
  console.warn(`[build-skill-bundles] ${path}: ${note}`);
}

let sweepRuns = 0;

function reapStaleStagingRoots(stagingParent: string): boolean {
  sweepRuns += 1;
  const cutoff = Date.now() - STALE_STAGING_AGE_MS;
  let entries: string[];
  try {
    entries = readdirSync(stagingParent);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    noticeOnce(stagingParent, `could not be swept for reclaimable scratch (${reason})`);
    return false;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGING_ROOT_PREFIX)) continue;
    const full = join(stagingParent, name);
    if (name.startsWith(KEPT_TREE_PREFIX)) {
      noticeOnce(
        full,
        'not reclaimed; it holds the tree a failed publish kept, which nothing removes automatically',
      );
      continue;
    }
    const age = inspectTree(full);
    if (!age.ok) {
      if (age.failed !== 'ENOENT') {
        noticeOnce(full, `not reclaimed; its age could not be established (${age.failed})`);
      }
      continue;
    }
    if (age.newest >= cutoff) continue;
    discardTree(full);
  }
  return true;
}

const sweptStagingParents = new Set<string>();

function openStagingRoot(distDir: string): string {
  const stagingParent = stagingParentFor(distDir);
  mkdirSync(stagingParent, { recursive: true });
  if (!sweptStagingParents.has(stagingParent) && reapStaleStagingRoots(stagingParent)) {
    sweptStagingParents.add(stagingParent);
  }
  return mkdtempSync(join(stagingParent, STAGING_ROOT_PREFIX));
}

/* WARN: `packages/app/scripts/copy-excalidraw-assets.mjs` publishes a directory by the same
   stage-then-displace-then-rename shape; its failure semantics are its own. */
function publishTree(stagingRoot: string, staged: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const holder = mkdtempSync(`${stagingRoot}-superseded-`);
  const superseded = join(holder, basename(dest));
  let displaced = false;
  let stranded = false;
  try {
    try {
      renameSync(dest, superseded);
      displaced = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && existsSync(dest)) throw err;
      if (code !== 'ENOENT') {
        console.warn(
          `[build-skill-bundles] could not displace ${dest} before publishing: ${code ?? (err as Error).message}`,
        );
      }
    }
    try {
      renameSync(staged, dest);
    } catch (err) {
      if (peerPublished(dest, err)) {
        console.warn(
          `[build-skill-bundles] yielded ${dest} to a peer that published it first; discarding this run's tree for it`,
        );
        return;
      }
      if (!displaced) throw err;
      if (reinstateTree(superseded, dest)) throw err;
      stranded = true;
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      const outcome = keepDisplacedTree(holder);
      const copy = join(outcome.root, basename(dest));
      const fate = outcome.kept
        ? `kept at ${copy}`
        : `left at ${copy}, which a later build may reclaim`;
      throw new Error(
        `[build-skill-bundles] could not publish ${dest} (${reason}) and could not put back the tree it displaced: ${dest} is now absent and that tree is its only copy, ${fate}`,
      );
    }
  } finally {
    if (!stranded) discardTree(holder);
  }
}

function stageComposedBundle(
  sourceDir: string,
  stageDir: string,
  resolve: (name: string) => string,
): { composed: string; placeholders: string[] } {
  const source = readFileSync(join(sourceDir, 'SKILL.md'), 'utf-8');
  const { composed, placeholders } = composeSkill(source, resolve);
  cpSync(sourceDir, stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'SKILL.md'), composed, 'utf-8');
  return { composed, placeholders };
}

/*
 * WARN: `packages/cli/scripts/build-skill-assets.ts` calls `buildSkillBundles`
 * and `buildPackSkills` by relative path and depends on both signatures, so a
 * change to either one has to land in that consumer in the same edit.
 */
/**
 * Compose every bundle and write the result to `distDir/<bundle>/SKILL.md`.
 * Returns one entry per bundle.
 */
export function buildSkillBundles(paths: SkillBundlePaths = defaultPaths()): ComposedBundle[] {
  const resolve = sharedResolver(paths.skillsDir);
  const results: ComposedBundle[] = [];
  const stagingRoot = openStagingRoot(paths.distDir);
  try {
    for (const bundle of BUNDLE_IDS) {
      const stageDir = join(stagingRoot, bundle);
      const { composed, placeholders } = stageComposedBundle(
        join(paths.skillsDir, bundle),
        stageDir,
        resolve,
      );
      const outDir = join(paths.distDir, bundle);
      publishTree(stagingRoot, stageDir, outDir);
      results.push({ bundle, composed, placeholders, outputPath: join(outDir, 'SKILL.md') });
    }
  } finally {
    discardTree(stagingRoot);
  }
  return results;
}

/**
 * Compose every per-pack skill into the dist tree the same way the named bundles
 * are composed. Pack skills carry no `_shared` placeholders today, so composition
 * is an identity transform — but routing them through `composeSkill` keeps them
 * on the same mechanism, and (critically) gets them INTO
 * `dist/assets/skills/packs/<id>/` so the published CLI + desktop bundles actually
 * ship them. Without this, `resolveBundledSkillDir('packs/<id>')` only resolves
 * against the source tree (dev), and `ok seed`'s pack-skill install silently
 * no-ops in any built artifact.
 *
 * A decomposed pack holds several `SKILL.md` files (root + one per member
 * scenario dir); the dist tree keeps that nested layout verbatim, since the
 * installer and the mirror both enumerate it. Returns the skill names built.
 */
export function buildPackSkills(paths: SkillBundlePaths = defaultPaths()): string[] {
  const packsSrc = join(paths.skillsDir, 'packs');
  if (!existsSync(packsSrc)) return [];
  const resolve = sharedResolver(paths.skillsDir);
  const built: string[] = [];
  const stagingRoot = openStagingRoot(paths.distDir);
  try {
    for (const entry of readdirSync(packsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(packsSrc, entry.name);
      const skills = enumeratePackSkills(sourceDir);
      if (skills.length === 0) continue;
      const composedSkills = skills.map((skill) => ({
        name: skill.name,
        rel: relative(sourceDir, skill.sourceDir),
        composed: composeSkill(readFileSync(join(skill.sourceDir, 'SKILL.md'), 'utf-8'), resolve)
          .composed,
      }));
      const stageDir = join(stagingRoot, 'packs', entry.name);
      cpSync(sourceDir, stageDir, { recursive: true });
      for (const skill of composedSkills) {
        writeFileSync(join(stageDir, skill.rel, 'SKILL.md'), skill.composed, 'utf-8');
        built.push(skill.name);
      }
      publishTree(stagingRoot, stageDir, join(paths.distDir, 'packs', entry.name));
    }
  } finally {
    discardTree(stagingRoot);
  }
  return built;
}

/**
 * Compose the Agent Plugins (agent-plugins.org) view of the built-ins: a
 * conformant plugin directory —
 * `dist/assets/agent-plugin/{plugin.json, skills/<real skill name>/…}`.
 *
 * Derived, not a second source: the internal `assets/skills/<id>` layout stays
 * the single source of truth (its id→name indirection and probe chain are
 * load-bearing across installed apps), and this artifact re-materializes from
 * it on every build, so it cannot drift. The `skills/` children carry the
 * skills' REAL names, per the standard's install convention.
 */
export function buildAgentPluginArtifact(paths: SkillBundlePaths = defaultPaths()): string {
  const outRoot = join(paths.distDir, '..', 'agent-plugin');
  const resolve = sharedResolver(paths.skillsDir);
  const stagingRoot = openStagingRoot(paths.distDir);
  const stageRoot = join(stagingRoot, 'agent-plugin');
  try {
    for (const bundle of BUNDLE_IDS) {
      stageComposedBundle(
        join(paths.skillsDir, bundle),
        join(stageRoot, 'skills', BUNDLE_SKILL_NAME[bundle]),
        resolve,
      );
    }
    const manifest = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'open-knowledge',
      description:
        'OpenKnowledge built-in skills: project workflow, discovery, and skill authoring',
      author: { name: 'Inkeep' },
      repository: 'https://github.com/inkeep/open-knowledge',
      keywords: ['openknowledge', 'knowledge-base'],
    };
    writeFileSync(
      join(stageRoot, 'plugin.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf-8',
    );
    publishTree(stagingRoot, stageRoot, outRoot);
  } finally {
    discardTree(stagingRoot);
  }
  return outRoot;
}

interface ByteEqualityResult {
  readonly ok: boolean;
  readonly violations: string[];
}

/**
 * Byte-equality guard. For every `{{> _shared/<name>.md }}`
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
    if (result.ok) {
      console.log('[build-skill-bundles] shared-content byte-equality check passed.');
    } else {
      console.error('[build-skill-bundles] shared-content byte-equality check FAILED:');
      for (const v of result.violations) console.error(`  - ${v}`);
      process.exitCode = 1;
    }
  } else {
    let stage = 'composing the skill bundles';
    try {
      const built = buildSkillBundles();
      for (const b of built) {
        const note =
          b.placeholders.length > 0
            ? ` (resolved ${b.placeholders.length} placeholder(s): ${b.placeholders.join(', ')})`
            : ' (no placeholders)';
        console.log(`[build-skill-bundles] composed ${b.bundle} → ${b.outputPath}${note}`);
      }
      stage = 'composing the pack skills';
      const packs = buildPackSkills();
      if (packs.length > 0) {
        console.log(
          `[build-skill-bundles] composed ${packs.length} pack skill(s): ${packs.join(', ')}`,
        );
      }
      stage = 'composing the Agent Plugins artifact';
      const pluginRoot = buildAgentPluginArtifact();
      console.log(`[build-skill-bundles] composed Agent Plugins artifact → ${pluginRoot}`);
    } catch (err) {
      console.error(`[build-skill-bundles] ${stage} failed:`);
      console.error(err);
      process.exitCode = 1;
    }
  }
}

export const __testing = { peerPublished, keepDisplacedTree, sweepRuns: () => sweepRuns };
