import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  SKILL_NAME_REGEX,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { tracedMkdirSync, tracedRmSync, tracedSymlinkSync } from './fs-traced.ts';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import { INTERNAL_BUNDLE_SKILL_NAMES } from './skill-bundles.ts';
import { hostSkillsRootEscapes, validateSkillForInstall } from './skill-projection.ts';

const logger = getLogger('skill-reconcile');

const SHIPPED_BUNDLE_NAMES = INTERNAL_BUNDLE_SKILL_NAMES;

interface ReconcileAction {
  name: string;
  editor: EditorId | null;
}

export interface ReconcileResult {
  healed: ReconcileAction[];
  replaced: ReconcileAction[];
  orphansRemoved: ReconcileAction[];
  skipped: ReconcileAction[];
}

interface DetectionRoot {
  rel: string;
  editor: EditorId | null;
}

function detectionRoots(): DetectionRoot[] {
  const roots: DetectionRoot[] = [];
  for (const id of PROJECT_SKILL_EDITOR_IDS) {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel !== null) roots.push({ rel, editor: id });
  }
  roots.push({ rel: AGENTS_SKILLS_ROOT, editor: null });
  return roots;
}

function relativeLinkTarget(hostRoot: string, sourceDir: string): string {
  const rel = relative(hostRoot, resolve(sourceDir));
  return isAbsolute(rel) ? resolve(sourceDir) : rel;
}

const DIRS_EQUAL_MAX_BYTES = 1_048_576;

function parseSkillManifest(md: string): { fm: Record<string, unknown>; body: string } {
  const { frontmatter: fenced, body } = stripFrontmatter(md);
  let fm: Record<string, unknown> = {};
  if (fenced !== '') {
    try {
      const parsed = parseYaml(unwrapFrontmatterFences(fenced));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fm = parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return { fm, body };
}

function skillManifestsSame(mdA: string, mdB: string): boolean {
  const a = parseSkillManifest(mdA);
  const b = parseSkillManifest(mdB);
  if (a.body !== b.body) return false;
  for (const key of Object.keys(a.fm)) {
    if (key in b.fm && JSON.stringify(a.fm[key]) !== JSON.stringify(b.fm[key])) return false;
  }
  return true;
}

function sameSkillModuloFrontmatter(a: string, b: string): boolean {
  const listA = listFiles(a);
  const listB = listFiles(b);
  if (listA.length !== listB.length) return false;
  let total = 0;
  for (let i = 0; i < listA.length; i += 1) {
    if (listA[i] !== listB[i]) return false;
    const rel = listA[i] as string;
    const fileA = join(a, rel);
    const fileB = join(b, rel);
    total += statSync(fileA).size + statSync(fileB).size;
    if (total > DIRS_EQUAL_MAX_BYTES) return false;
    const bufA = readFileSync(fileA);
    const bufB = readFileSync(fileB);
    if (bufA.equals(bufB)) continue;
    if (rel !== 'SKILL.md') return false;
    if (!skillManifestsSame(bufA.toString('utf8'), bufB.toString('utf8'))) return false;
  }
  return true;
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function linkInto(hostRoot: string, linkPath: string, sourceDir: string): void {
  tracedRmSync(linkPath, { recursive: true, force: true });
  tracedMkdirSync(hostRoot, { recursive: true });
  tracedSymlinkSync(relativeLinkTarget(hostRoot, sourceDir), linkPath, 'dir');
}

function pointsAtSource(linkPath: string, sourceDir: string): boolean {
  try {
    const raw = readlinkSync(linkPath);
    const resolved = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
    return resolve(resolved) === resolve(sourceDir);
  } catch {
    return false;
  }
}

function isForeignSymlink(linkPath: string, skillsRoot: string): boolean {
  try {
    const raw = readlinkSync(linkPath);
    const target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(linkPath), raw);
    if (!existsSync(target)) return false;
    const rel = relative(resolve(skillsRoot), target);
    return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
  } catch (err) {
    logger.warn(
      { linkPath, err },
      'isForeignSymlink: could not resolve symlink; treating as reconcile-managed',
    );
    return false;
  }
}

const SUFFIX_TOKENS: readonly string[] = [...PROJECT_SKILL_EDITOR_IDS, 'agents'];

function suffixBase(name: string): string | null {
  for (const token of SUFFIX_TOKENS) {
    const suffix = `-${token}`;
    if (name.length > suffix.length && name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return null;
}

function collapseAccretedSuffixDupes(opts: { projectDir: string; skillsRoot: string }): void {
  const { projectDir, skillsRoot } = opts;
  if (!existsSync(skillsRoot)) return;
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return;
  }
  const roots = detectionRoots();
  for (const suffixed of entries) {
    const base = suffixBase(suffixed);
    if (base === null) continue;
    const suffixedDir = resolve(skillsRoot, suffixed);
    const baseDir = resolve(skillsRoot, base);
    if (!existsSync(baseDir)) continue;
    try {
      const stat = lstatSync(suffixedDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (!existsSync(join(suffixedDir, 'SKILL.md')) || !existsSync(join(baseDir, 'SKILL.md'))) {
        continue;
      }
      if (!sameSkillModuloFrontmatter(baseDir, suffixedDir)) continue;
      for (const { rel } of roots) {
        const hostRoot = resolve(projectDir, rel);
        if (hostSkillsRootEscapes(projectDir, hostRoot)) continue;
        const linkPath = join(hostRoot, suffixed);
        if (pointsAtSource(linkPath, suffixedDir)) linkInto(hostRoot, linkPath, baseDir);
      }
      tracedRmSync(suffixedDir, { recursive: true, force: true });
      logger.info({ base, suffixed }, 'collapsed accreted suffix-duplicate skill into its base');
    } catch (err) {
      logger.warn({ err, base, suffixed }, 'suffix-dupe collapse skipped one entry after error');
    }
  }
}

export async function reconcileSkillInstalls(opts: {
  projectDir: string;
  skillsRoot: string;
}): Promise<ReconcileResult> {
  const { projectDir, skillsRoot } = opts;
  const result: ReconcileResult = {
    healed: [],
    replaced: [],
    orphansRemoved: [],
    skipped: [],
  };
  const markerAdds = new Map<string, Set<EditorId>>();
  const addMarkerHost = (name: string, editor: EditorId | null) => {
    if (editor === null) return;
    const set = markerAdds.get(name) ?? new Set<EditorId>();
    set.add(editor);
    markerAdds.set(name, set);
  };

  for (const { rel, editor } of detectionRoots()) {
    const hostRoot = resolve(projectDir, rel);
    if (!existsSync(hostRoot)) continue;
    if (hostSkillsRootEscapes(projectDir, hostRoot)) continue;

    let entries: string[];
    try {
      entries = readdirSync(hostRoot);
    } catch (err) {
      logger.warn({ hostRoot, err }, 'reconcile: skipped unreadable host skills root');
      continue;
    }

    for (const name of entries) {
      if (SHIPPED_BUNDLE_NAMES.has(name)) continue;
      const entryPath = join(hostRoot, name);
      const sourceDir = resolve(skillsRoot, name);
      const sourceExists = existsSync(sourceDir);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          if (pointsAtSource(entryPath, sourceDir) && sourceExists) continue;
          if (isForeignSymlink(entryPath, skillsRoot)) {
            result.skipped.push({ name, editor });
            continue;
          }
          if (sourceExists) {
            linkInto(hostRoot, entryPath, sourceDir);
            result.healed.push({ name, editor });
          } else {
            tracedRmSync(entryPath, { recursive: true, force: true });
            result.orphansRemoved.push({ name, editor });
          }
          continue;
        }
        if (!stat.isDirectory()) continue;

        if (!SKILL_NAME_REGEX.test(name)) {
          logger.warn(
            { skill: name, editor },
            'reconcile: skipping host-dir entry with a non-skill name',
          );
          continue;
        }

        if (sourceExists && sameSkillModuloFrontmatter(entryPath, sourceDir)) {
          linkInto(hostRoot, entryPath, sourceDir);
          result.replaced.push({ name, editor });
          addMarkerHost(name, editor);
          continue;
        }

        result.skipped.push({ name, editor });
      } catch (err) {
        logger.warn({ err, skill: name, editor }, 'reconcile skipped one skill entry after error');
      }
    }
  }

  if (markerAdds.size > 0) {
    const marker = readInstalledSkills(projectDir);
    for (const [name, editors] of markerAdds) {
      const sourceDir = resolve(skillsRoot, name);
      if (!existsSync(sourceDir)) continue;
      const prior = marker.skills[name];
      const hosts = Array.from(new Set([...(prior?.hosts ?? []), ...editors]));
      try {
        await recordSkillInstall(projectDir, name, {
          hosts,
          scope: prior?.scope ?? 'project',
          scripts: prior?.scripts ?? validateSkillForInstall(sourceDir, name).hasScripts,
          installedAt: prior?.installedAt ?? new Date().toISOString(),
        });
      } catch (err) {
        logger.warn({ err, skill: name }, 'reconcile marker update failed (non-fatal)');
      }
    }
  }

  try {
    collapseAccretedSuffixDupes({ projectDir, skillsRoot });
  } catch (err) {
    logger.warn({ err }, 'suffix-dupe collapse pass failed (non-fatal)');
  }

  return result;
}
