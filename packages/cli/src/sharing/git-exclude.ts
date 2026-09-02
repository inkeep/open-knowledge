import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  INSTALLED_SKILLS_REL,
  LEGACY_SKILL_STORE_ROOT,
  OK_DIR,
  parseInstalledSkills,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';
import { discoverGitRepository } from '@inkeep/open-knowledge-core/git-repository';
import { withHiddenWindowsConsole } from '@inkeep/open-knowledge-server';
import { ALL_EDITOR_IDS, EDITOR_TARGETS } from '../commands/editors.ts';

const CLAUDE_LAUNCH_JSON = '.claude/launch.json';

const OK_IGNORE_FILENAME = '.okignore';

const OK_CARVE_CHILDREN = `**/${OK_DIR}/*`;
const OK_CARVE_SKILLS_REINCLUDE = `!**/${LEGACY_SKILL_STORE_ROOT}/`;

export type ExcludeWriteResult =
  | { kind: 'updated'; appended: string[]; alreadyPresent: string[]; removed: string[] }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

export interface TrackedRefusal {
  kind: 'refused-tracked';
  tracked: string[];
  remediation: string;
}

export type SharingMode = 'shared' | 'local-only' | 'no-git';

export function getOkArtifactPaths(projectRoot: string): readonly string[] {
  const paths: string[] = [`${OK_DIR}/`, OK_IGNORE_FILENAME];
  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    if (target.projectConfigPath) {
      paths.push(toProjectRelative(target.projectConfigPath(projectRoot), projectRoot));
    }
  }
  paths.push(CLAUDE_LAUNCH_JSON);
  return Array.from(new Set(paths));
}

export function getInstalledSkillProjectionPaths(projectRoot: string): readonly string[] {
  const markerPath = join(projectRoot, ...INSTALLED_SKILLS_REL);
  if (!existsSync(markerPath)) return [];
  try {
    const marker = parseInstalledSkills(readFileSync(markerPath, 'utf-8'));
    if (!marker) return [];
    const paths: string[] = [];
    for (const [name, entry] of Object.entries(marker.skills)) {
      if (name === RESERVED_PROJECT_SKILL_NAME) continue;
      for (const host of entry.hosts) {
        const root = EDITOR_PROJECT_SKILL_ROOT[host as EditorId];
        if (root) paths.push(`${root}/${name}/`);
      }
    }
    return Array.from(new Set(paths));
  } catch {
    return [];
  }
}

export function addOkPathsToGitExclude(
  projectRoot: string,
  paths: readonly string[],
): ExcludeWriteResult | TrackedRefusal {
  const tracked = probeTrackedOkPaths(projectRoot, paths).tracked;
  if (tracked.length > 0) {
    return {
      kind: 'refused-tracked',
      tracked,
      remediation: formatTrackedRemediation(tracked),
    };
  }
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return resolved.result;

  const rawExisting = existsSync(resolved.path) ? readFileSync(resolved.path, 'utf-8') : '';

  const stale = new Set<string>(getInstalledSkillProjectionPaths(projectRoot));
  const drained: string[] = [];
  const existing =
    stale.size === 0
      ? rawExisting
      : rawExisting
          .split('\n')
          .filter((line) => {
            const trimmed = line.trim();
            if (!stale.has(trimmed)) return true;
            drained.push(trimmed);
            return false;
          })
          .join('\n');

  const presentVariants = collectPresentVariants(existing);

  const appended: string[] = [];
  const alreadyPresent: string[] = [];
  for (const p of paths) {
    if (hasAnyVariant(presentVariants, p)) {
      alreadyPresent.push(p);
    } else {
      appended.push(p);
    }
  }

  if (appended.length === 0 && drained.length === 0) {
    return { kind: 'updated', appended, alreadyPresent, removed: [] };
  }

  const separator =
    appended.length === 0 || existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const additions = appended.length === 0 ? '' : `${appended.join('\n')}\n`;
  try {
    writeFileSync(resolved.path, `${existing}${separator}${additions}`, 'utf-8');
  } catch {
    return { kind: 'no-exclude', reason: 'inaccessible' };
  }

  return { kind: 'updated', appended, alreadyPresent, removed: drained };
}

export function removeOkPathsFromGitExclude(
  projectRoot: string,
  paths: readonly string[],
): ExcludeWriteResult {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return resolved.result;
  if (!existsSync(resolved.path)) {
    return { kind: 'updated', appended: [], alreadyPresent: [], removed: [] };
  }

  const variantsByPath = paths.map((p) => buildVariants(p));
  const allVariants = new Set<string>();
  for (const set of variantsByPath) {
    for (const v of set) allVariants.add(v);
  }
  allVariants.add(OK_CARVE_CHILDREN);
  allVariants.add(OK_CARVE_SKILLS_REINCLUDE);
  for (const p of getInstalledSkillProjectionPaths(projectRoot)) {
    allVariants.add(p);
  }

  let before: string;
  try {
    before = readFileSync(resolved.path, 'utf-8');
  } catch {
    return { kind: 'no-exclude', reason: 'inaccessible' };
  }
  const lines = before.split('\n');
  const removedLines = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (allVariants.has(trimmed)) {
      removedLines.add(trimmed);
      continue;
    }
    kept.push(line);
  }

  const removed = [...removedLines];

  if (removedLines.size === 0) {
    return { kind: 'updated', appended: [], alreadyPresent: [], removed: [] };
  }

  const after = kept.join('\n');
  if (after !== before) {
    try {
      writeFileSync(resolved.path, after, 'utf-8');
    } catch {
      return { kind: 'no-exclude', reason: 'inaccessible' };
    }
  }
  return { kind: 'updated', appended: [], alreadyPresent: [], removed };
}

export function readSharingMode(projectRoot: string): SharingMode {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') {
    return resolved.result.reason === 'no-git' ||
      resolved.result.reason === 'malformed-pointer' ||
      resolved.result.reason === 'inaccessible'
      ? 'no-git'
      : 'shared';
  }
  if (!existsSync(resolved.path)) return 'shared';
  let content: string;
  try {
    content = readFileSync(resolved.path, 'utf-8');
  } catch {
    return 'shared';
  }
  const present = collectPresentVariants(content);
  const artifacts = getOkArtifactPaths(projectRoot);
  for (const p of artifacts) {
    if (hasAnyVariant(present, p)) return 'local-only';
  }
  if (present.has(OK_CARVE_CHILDREN)) return 'local-only';
  return 'shared';
}

export function getExcludedOkPaths(projectRoot: string): readonly string[] {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return [];
  if (!existsSync(resolved.path)) return [];
  let content: string;
  try {
    content = readFileSync(resolved.path, 'utf-8');
  } catch {
    return [];
  }
  const present = collectPresentVariants(content);
  const candidates = [
    ...getOkArtifactPaths(projectRoot),
    ...getInstalledSkillProjectionPaths(projectRoot),
  ];
  const reported = candidates.filter((p) => hasAnyVariant(present, p));

  const alreadyReported = new Set(reported);
  const skillRoots: string[] = [];
  for (const root of Object.values(EDITOR_PROJECT_SKILL_ROOT)) {
    if (root !== null) skillRoots.push(root);
  }
  const orphans: string[] = [];
  for (const line of present) {
    if (alreadyReported.has(line)) continue;
    if (line === OK_CARVE_CHILDREN || line === OK_CARVE_SKILLS_REINCLUDE) {
      orphans.push(line);
      continue;
    }
    const bare = line.replace(/^\//, '').replace(/\/$/, '');
    if (skillRoots.some((root) => bare.startsWith(`${root}/`) && bare.length > root.length + 1)) {
      orphans.push(line);
    }
  }
  return [...reported, ...orphans];
}

export function probeTrackedOkPaths(
  projectRoot: string,
  paths: readonly string[],
): { tracked: string[] } {
  const tracked: string[] = [];
  for (const p of paths) {
    const abs = resolve(projectRoot, p);
    if (!existsSync(abs)) continue;
    try {
      execFileSync(
        'git',
        ['ls-files', '--error-unmatch', '--', p],
        withHiddenWindowsConsole({
          cwd: projectRoot,
          stdio: ['ignore', 'ignore', 'ignore'],
        }),
      );
      tracked.push(p);
    } catch {}
  }
  return { tracked };
}

export function formatTrackedRemediation(tracked: readonly string[]): string {
  const lines: string[] = [];
  lines.push('Cannot switch OpenKnowledge to local-only — these OK files are tracked upstream:');
  lines.push('');
  for (const p of tracked) lines.push(`  ${p}`);
  lines.push('');
  lines.push(
    ".git/info/exclude only hides files that git isn't already tracking. To proceed, untrack them first:",
  );
  lines.push('');
  for (const p of tracked) {
    const arg = p.replace(/\/$/, '');
    const recursive = p.endsWith('/') ? '-r ' : '';
    lines.push(`  git rm --cached ${recursive}${arg}`);
  }
  lines.push('');
  lines.push(
    "Then re-run the command. Note: `git rm --cached` removes the files from the index — your teammates will see a deletion on their next pull. If you don't want that, leave sharing mode set to 'shared'.",
  );
  return lines.join('\n');
}

type ResolveExcludePathResult =
  | { kind: 'ok'; path: string }
  | { kind: 'no-exclude'; result: Extract<ExcludeWriteResult, { kind: 'no-exclude' }> };

function resolveExcludePath(projectRoot: string): ResolveExcludePathResult {
  const inspected = discoverGitRepository(projectRoot);
  switch (inspected.kind) {
    case 'repository': {
      const commonDir = inspected.repository.readCommonDir();
      if (commonDir.kind === 'unreadable') {
        return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'inaccessible' } };
      }
      const info = join(commonDir.path, 'info');
      if (!existsSync(info)) {
        return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'no-info-dir' } };
      }
      return { kind: 'ok', path: join(info, 'exclude') };
    }
    case 'absent':
      return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'no-git' } };
    case 'malformed-pointer':
      return {
        kind: 'no-exclude',
        result: { kind: 'no-exclude', reason: 'malformed-pointer' },
      };
    case 'inaccessible':
      return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'inaccessible' } };
  }
}

function buildVariants(path: string): Set<string> {
  const noTrail = path.replace(/\/$/, '');
  return new Set([path, noTrail, `/${path}`, `/${noTrail}`]);
}

function hasAnyVariant(presentVariants: Set<string>, path: string): boolean {
  for (const v of buildVariants(path)) {
    if (presentVariants.has(v)) return true;
  }
  return false;
}

function collectPresentVariants(excludeFileContent: string): Set<string> {
  const present = new Set<string>();
  for (const raw of excludeFileContent.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    present.add(trimmed);
  }
  return present;
}

function toProjectRelative(absPath: string, projectRoot: string): string {
  return toPosix(relative(projectRoot, absPath));
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
