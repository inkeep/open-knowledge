import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { gitCleanEnv } from '../scripts/git-clean-env.mjs';
import { EXTENSIONS, isUncachedTestFile, UNCACHED_TIER_CONFIG } from './uncached-tier';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RECONCILED = Symbol.for('open-knowledge.uncached-tier.reconciled');
const TEST_NAME = new RegExp(`\\.(?:test|e2e)\\.(?:${EXTENSIONS.join('|')})$`);

export type UncachedTierProject = { name: string; dir: string; collected: string[] };

export function listUncachedTestFiles(root: string): string[] {
  const listed = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ':(glob)**/*.uncached.*',
    ],
    { cwd: root, encoding: 'utf8', env: gitCleanEnv(), windowsHide: true },
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `${UNCACHED_TIER_CONFIG}: git ls-files could not list the test files named for the uncached tier (${listed.error?.message ?? listed.stderr.trim()}), so the tier cannot show that it runs every one of them. Run it from a git work tree.`,
    );
  }
  return listed.stdout
    .split('\0')
    .filter((path) => TEST_NAME.test(path) && existsSync(join(root, path)));
}

function owningPackage(root: string, path: string): string {
  let dir = dirname(path);
  while (dir !== '.' && !existsSync(join(root, dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

export function uncachedTierProblems(
  root: string,
  listed: string[],
  projects: UncachedTierProject[],
): string[] {
  const collectors = new Map<string, string[]>();
  for (const { name, collected } of projects) {
    for (const path of collected) collectors.set(path, [...(collectors.get(path) ?? []), name]);
  }
  const problems: string[] = [];
  if (!listed.some(isUncachedTestFile)) {
    problems.push(
      'git lists no file with the .uncached.test suffix, so the tier would pass having run nothing.',
    );
  }
  for (const path of listed) {
    if (!isUncachedTestFile(path)) {
      problems.push(
        `${path} names the uncached tier, but .uncached.test does not end its name, so no project here collects it and a cached tier may run it instead. Put .uncached.test last, with any other infix ahead of it, or drop .uncached. if the test reads only files inside its package's key.`,
      );
      continue;
    }
    const names = collectors.get(path) ?? [];
    if (names.length > 1) {
      problems.push(
        `${path} is collected by more than one project (${names.join(', ')}), so it runs twice. Narrow the include of all but one of those configs.`,
      );
    }
    if (names.length > 0) continue;
    const covering = projects.find(({ dir }) => dir === owningPackage(root, path));
    problems.push(
      covering === undefined
        ? `${path} takes the .uncached.test suffix, but no project here covers its package, so no tier would run it (every cached tier excludes the suffix through test-support/vitest.base.ts). Add that package's Vitest config to SOURCES in ${UNCACHED_TIER_CONFIG}, or drop the suffix if the test reads only files inside its package's key.`
        : `${path} takes the .uncached.test suffix and sits under ${covering.dir}, but that project's include and exclude do not collect it, so no tier would run it. Fix ${covering.name}'s include or exclude so the uncached project collects it.`,
    );
  }
  for (const path of collectors.keys()) {
    if (!listed.includes(path)) {
      problems.push(
        `${path} takes the .uncached.test suffix and the tier collects it, but git ignores it, so it would run only locally and CI would never see it. Move it out of the ignored path, or drop the suffix.`,
      );
    }
  }
  return problems;
}

function gitPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export default async function reconcile(project: TestProject): Promise<void> {
  const state = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (state[RECONCILED]) return;
  state[RECONCILED] = true;
  const declared = project.vitest.config.projects.length;
  if (project.vitest.projects.length < declared) {
    throw new Error(
      `${UNCACHED_TIER_CONFIG}: the --project filter (${project.vitest.config.project.join(', ')}) keeps ${project.vitest.projects.length} of the tier's ${declared} projects, so the tier cannot show that it runs every suffixed file git lists. Drop --project, and narrow the run with a file filter instead.`,
    );
  }
  const listed = listUncachedTestFiles(OK_ROOT);
  const projects = await Promise.all(
    project.vitest.projects.map(async (each) => ({
      name: each.name,
      dir: gitPath(OK_ROOT, each.config.root) || '.',
      collected: (await each.globTestFiles()).testFiles.map((file) => gitPath(OK_ROOT, file)),
    })),
  );
  const problems = uncachedTierProblems(OK_ROOT, listed, projects);
  console.log(
    `uncached tier: ${listed.filter(isUncachedTestFile).length} suffixed test files listed by git, ${new Set(projects.flatMap(({ collected }) => collected)).size} collected (${projects
      .map(({ name, collected }) => `${name}: ${collected.length}`)
      .join(', ')})`,
  );
  if (problems.length > 0) throw new Error(`${UNCACHED_TIER_CONFIG}:\n  ${problems.join('\n  ')}`);
}
