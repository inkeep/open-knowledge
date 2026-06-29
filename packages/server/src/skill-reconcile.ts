import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
  SKILL_NAME_REGEX,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import {
  tracedCpSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmSync,
  tracedSymlinkSync,
} from './fs-traced.ts';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import { isProjectSkillManaged } from './skill-management.ts';
import { hostSkillsRootEscapes, validateSkillForInstall } from './skill-projection.ts';

const logger = getLogger('skill-reconcile');

const SHIPPED_BUNDLE_NAMES = new Set(['open-knowledge', 'open-knowledge-discovery']);

interface ReconcileAction {
  name: string;
  editor: EditorId | null;
}

export interface ReconcileResult {
  healed: ReconcileAction[];
  adopted: ReconcileAction[];
  replaced: ReconcileAction[];
  collided: ReconcileAction[];
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
  roots.push({ rel: '.agents/skills', editor: null });
  return roots;
}

function relativeLinkTarget(hostRoot: string, sourceDir: string): string {
  const rel = relative(hostRoot, resolve(sourceDir));
  return isAbsolute(rel) ? resolve(sourceDir) : rel;
}

/** Beyond this total byte size we skip the byte-compare and treat the dirs as
 *  NOT equal (a collision) — runs at boot, so we don't block startup reading a
 *  multi-MB reference dataset. "Not equal" is the safe default: the collision
 *  path preserves both copies (suffix-adopt), never deletes. */
const DIRS_EQUAL_MAX_BYTES = 1_048_576;

function dirsEqual(a: string, b: string): boolean {
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
    if (total > DIRS_EQUAL_MAX_BYTES) return false; // too large to byte-compare cheaply
    if (!readFileSync(fileA).equals(readFileSync(fileB))) return false;
  }
  return true;
}

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
    if (total > DIRS_EQUAL_MAX_BYTES) return false; // too large to compare cheaply → not-same (safe)
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

function moveDir(from: string, to: string): void {
  tracedMkdirSync(dirname(to), { recursive: true });
  try {
    tracedRenameSync(from, to);
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    tracedCpSync(from, to, { recursive: true });
    tracedRmSync(from, { recursive: true, force: true });
  }
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

export function countImportableEditorSkills(opts: {
  projectDir: string;
  skillsRoot: string;
}): number {
  const { projectDir, skillsRoot } = opts;
  const importable = new Set<string>();
  for (const { rel } of detectionRoots()) {
    const hostRoot = resolve(projectDir, rel);
    if (!existsSync(hostRoot) || hostSkillsRootEscapes(projectDir, hostRoot)) continue;
    let entries: string[];
    try {
      entries = readdirSync(hostRoot);
    } catch (err) {
      logger.warn(
        { hostRoot, err: (err as Error).message },
        'reconcile: skipped unreadable host skills root',
      );
      continue;
    }
    for (const name of entries) {
      if (SHIPPED_BUNDLE_NAMES.has(name) || !SKILL_NAME_REGEX.test(name)) continue;
      const entryPath = join(hostRoot, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entryPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const sourceDir = resolve(skillsRoot, name);
      if (
        existsSync(sourceDir) &&
        (dirsEqual(entryPath, sourceDir) || sameSkillModuloFrontmatter(entryPath, sourceDir))
      ) {
        continue;
      }
      importable.add(name);
    }
  }
  return importable.size;
}

export async function reconcileSkillInstalls(opts: {
  projectDir: string;
  skillsRoot: string;
}): Promise<ReconcileResult> {
  const { projectDir, skillsRoot } = opts;
  const result: ReconcileResult = {
    healed: [],
    adopted: [],
    replaced: [],
    collided: [],
    orphansRemoved: [],
    skipped: [],
  };
  const managed = isProjectSkillManaged(projectDir);
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
      logger.warn(
        { hostRoot, err: (err as Error).message },
        'reconcile: skipped unreadable host skills root',
      );
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
          if (pointsAtSource(entryPath, sourceDir) && sourceExists) continue; // managed, OK
          if (sourceExists) {
            linkInto(hostRoot, entryPath, sourceDir); // heal drifted link
            result.healed.push({ name, editor });
          } else {
            tracedRmSync(entryPath, { recursive: true, force: true }); // orphan link
            result.orphansRemoved.push({ name, editor });
          }
          continue;
        }
        if (!stat.isDirectory()) continue; // ignore stray files

        if (!SKILL_NAME_REGEX.test(name)) {
          logger.warn(
            { skill: name, editor },
            'reconcile: skipping host-dir entry with a non-skill name',
          );
          continue;
        }

        if (
          sourceExists &&
          (dirsEqual(entryPath, sourceDir) || sameSkillModuloFrontmatter(entryPath, sourceDir))
        ) {
          linkInto(hostRoot, entryPath, sourceDir);
          result.replaced.push({ name, editor });
          addMarkerHost(name, editor);
          continue;
        }

        if (!managed) {
          result.skipped.push({ name, editor });
          continue;
        }

        if (!sourceExists) {
          moveDir(entryPath, sourceDir);
          linkInto(hostRoot, entryPath, sourceDir);
          result.adopted.push({ name, editor });
          addMarkerHost(name, editor);
        } else {
          const suffixed = `${name}-${editor ?? 'agents'}`;
          const suffixedSource = resolve(skillsRoot, suffixed);
          if (existsSync(suffixedSource)) {
            logger.warn(
              { skill: name, editor, suffixed },
              'collision: suffixed slot already occupied — skipping (manual resolution needed)',
            );
            continue;
          }
          moveDir(entryPath, suffixedSource);
          linkInto(hostRoot, join(hostRoot, suffixed), suffixedSource);
          result.collided.push({ name, editor });
          addMarkerHost(suffixed, editor);
        }
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

  return result;
}
