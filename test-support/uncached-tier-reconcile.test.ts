import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import { createVitest, type TestProject } from 'vitest/node';
import { gitCleanEnv } from '../scripts/git-clean-env.mjs';
import tierConfig from '../vitest.uncached.config';
import { listUncachedTestFiles, uncachedTierProblems } from './uncached-tier-reconcile';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-uncached-tier-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...gitCleanEnv(),
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  expect(result.status, result.stderr).toBe(0);
}

const SERVER = 'packages/server/src/reads-app.uncached.test.ts';
const privateInfix = (stem: string, suffix: string) => `${stem}.private.${suffix}`;
const TRANSPOSED = privateInfix('packages/server/src/reads-app.uncached', 'test.ts');
const INFIXED = privateInfix('packages/server/src/reads-app', 'uncached.test.ts');
const server = (collected: string[]) => ({
  name: 'packages/server/vitest.config.ts',
  dir: 'packages/server',
  collected,
});
const scripts = (collected: string[]) => ({
  name: 'vitest.scripts.config.ts',
  dir: '.',
  collected,
});
const packages = () =>
  workspace({
    'package.json': '{}',
    'packages/server/package.json': '{}',
    'packages/core/package.json': '{}',
  });

describe('the uncached tier reconciles the suffixed files git lists against what its projects collect', () => {
  test('a listed file one project collects passes', () => {
    expect(uncachedTierProblems(packages(), [SERVER], [server([SERVER]), scripts([])])).toEqual([]);
  });

  test('a listed file its covering project does not collect names that project config', () => {
    expect(uncachedTierProblems(packages(), [SERVER], [server([]), scripts([])])).toEqual([
      expect.stringContaining(
        `${SERVER} takes the .uncached.test suffix and sits under packages/server, but that project's include and exclude do not collect it, so no tier would run it. Fix packages/server/vitest.config.ts's include or exclude`,
      ),
    ]);
  });

  test('a listed file in a package no project covers is misplaced', () => {
    const misplaced = 'packages/core/src/reads-server.uncached.test.ts';
    expect(
      uncachedTierProblems(packages(), [SERVER, misplaced], [server([SERVER]), scripts([])]),
    ).toEqual([
      expect.stringContaining(
        `${misplaced} takes the .uncached.test suffix, but no project here covers its package`,
      ),
    ]);
  });

  test('a file two projects collect runs twice, and fails', () => {
    expect(
      uncachedTierProblems(packages(), [SERVER], [server([SERVER]), scripts([SERVER])]),
    ).toEqual([expect.stringContaining(`${SERVER} is collected by more than one project`)]);
  });

  test('a file the tier collects but git does not list fails, because CI would never see it', () => {
    const ignored = 'packages/server/src/scratch/local.uncached.test.ts';
    expect(
      uncachedTierProblems(packages(), [SERVER], [server([SERVER, ignored]), scripts([])]),
    ).toEqual([
      expect.stringContaining(
        `${ignored} takes the .uncached.test suffix and the tier collects it, but git ignores it`,
      ),
    ]);
  });

  test('a test named for the tier with .uncached. short of its closing suffix fails, since no tier project collects it', () => {
    expect(
      uncachedTierProblems(packages(), [SERVER, TRANSPOSED], [server([SERVER]), scripts([])]),
    ).toEqual([expect.stringContaining(`${TRANSPOSED} names the uncached tier, but`)]);
  });

  test('the same infix ahead of the closing .uncached.test suffix passes', () => {
    expect(
      uncachedTierProblems(packages(), [SERVER, INFIXED], [server([SERVER, INFIXED]), scripts([])]),
    ).toEqual([]);
  });

  test('an empty listing fails rather than passing having run nothing', () => {
    expect(uncachedTierProblems(packages(), [], [server([]), scripts([])])).toEqual([
      'git lists no file with the .uncached.test suffix, so the tier would pass having run nothing.',
    ]);
  });
});

describe('reconcile() under win32 path semantics, where relative() emits backslashes', () => {
  test('a listed file its covering project leaves uncollected is the only problem, and names that project', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const listed = listUncachedTestFiles(root);
    const inServer = (path: string) => path.startsWith('packages/server/');
    const uncollected = listed.find(inServer);
    expect(uncollected).toBeDefined();
    const project = (name: string, dir: string, files: string[]) => ({
      name,
      config: { root: resolve(root, dir) },
      globTestFiles: async () => ({ testFiles: files.map((file) => resolve(root, file)) }),
    });
    vi.doMock('node:path', () => {
      const onWindows = { ...win32, join };
      return { ...onWindows, default: onWindows };
    });
    onTestFinished(() => {
      vi.doUnmock('node:path');
      vi.resetModules();
    });
    vi.resetModules();
    const { default: reconcile } = await import('./uncached-tier-reconcile');
    const tier = {
      vitest: {
        projects: [
          project(
            'packages/server/vitest.config.ts',
            'packages/server',
            listed.filter((path) => inServer(path) && path !== uncollected),
          ),
          project(
            'vitest.scripts.config.ts',
            '.',
            listed.filter((path) => !inServer(path)),
          ),
        ],
        config: {
          projects: [
            { test: { name: 'packages/server/vitest.config.ts' } },
            { test: { name: 'vitest.scripts.config.ts' } },
          ],
        },
      },
    } as unknown as TestProject;
    const failure = await reconcile(tier).catch((error: Error) => error);
    expect(failure instanceof Error ? failure.message.split('\n  ') : failure).toEqual([
      'vitest.uncached.config.ts:',
      expect.stringContaining(
        `${uncollected} takes the .uncached.test suffix and sits under packages/server, but that project's include and exclude do not collect it, so no tier would run it. Fix packages/server/vitest.config.ts's include or exclude`,
      ),
    ]);
  });
});

describe('reconcile() over the real tier config, as Vitest resolves it under a --project filter', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const SERVER_PROJECT = 'packages/server/vitest.config.ts';
  const SCRIPTS_PROJECT = 'vitest.scripts.config.ts';

  async function reconcileUnder(project: string[] | undefined) {
    const vitest = await createVitest('test', {
      root,
      config: 'vitest.uncached.config.ts',
      watch: false,
      ...(project === undefined ? {} : { project }),
    });
    try {
      const resolved = vitest.projects.map(({ name }) => name).sort();
      expect(resolved.length).toBeGreaterThan(0);
      Reflect.deleteProperty(globalThis, Symbol.for('open-knowledge.uncached-tier.reconciled'));
      const { default: reconcile } = await import('./uncached-tier-reconcile');
      const failure = await reconcile(vitest.projects[0] as TestProject).then(
        () => undefined,
        (error: Error) => error,
      );
      return { resolved, failure };
    } finally {
      await vitest.close();
    }
  }

  let declared: string[] = [];

  beforeAll(async () => {
    const { resolved, failure } = await reconcileUnder(undefined);
    expect(failure).toBeUndefined();
    declared = resolved;
  });

  test('every declared project is a Vitest config on disk, the server and root scripts configs among them', () => {
    expect(declared).toEqual(expect.arrayContaining([SERVER_PROJECT, SCRIPTS_PROJECT]));
    expect(declared.filter((name) => !existsSync(join(root, name)))).toEqual([]);
  });

  test.each([
    { filter: [SCRIPTS_PROJECT], kept: () => [SCRIPTS_PROJECT] },
    {
      filter: [`!${SCRIPTS_PROJECT}`],
      kept: () => declared.filter((name) => name !== SCRIPTS_PROJECT),
    },
  ])(
    'a run narrowed by --project=$filter refuses once, naming the filter rather than SOURCES',
    async ({ filter, kept }) => {
      const { resolved, failure } = await reconcileUnder(filter);
      expect(resolved).toEqual(kept());
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : '';
      expect(message).toContain('--project');
      expect(message).not.toContain('SOURCES');
      expect(listUncachedTestFiles(root).filter((path) => message.includes(path))).toEqual([]);
    },
  );

  test.each([
    { form: 'the * glob', filter: () => ['*'] },
    { form: 'every declared project by name', filter: () => declared },
  ])(
    'a run whose filter ($form) keeps every declared project reconciles cleanly',
    async ({ filter }) => {
      const { resolved, failure } = await reconcileUnder(filter());
      expect(resolved).toEqual(declared);
      expect(failure).toBeUndefined();
    },
  );
});

describe("the tier's discovery domain: what git lists, and what every project excludes", () => {
  test('git lists tracked and untracked suffixed files, never an ignored one or one under node_modules', () => {
    const root = workspace({
      '.gitignore': 'node_modules/\nscratch/\n',
      'packages/server/src/tracked.uncached.test.ts': '',
      'packages/server/src/untracked.uncached.test.ts': '',
      'packages/server/src/scratch/ignored.uncached.test.ts': '',
      'packages/server/node_modules/vendored/vendored.uncached.test.ts': '',
      'packages/server/src/cached.test.ts': '',
    });
    git(root, ['init', '-q']);
    git(root, ['add', '.gitignore', 'packages/server/src/tracked.uncached.test.ts']);
    git(root, ['commit', '-qm', 'base']);
    expect(listUncachedTestFiles(root).sort()).toEqual([
      'packages/server/src/tracked.uncached.test.ts',
      'packages/server/src/untracked.uncached.test.ts',
    ]);
  });

  test('git lists a test that carries .uncached. short of its closing suffix, and no file that is not a test', () => {
    const root = workspace({
      [SERVER]: '',
      [TRANSPOSED]: '',
      'packages/server/src/reads-app.uncached.test-helper.ts': '',
      'packages/server/src/__snapshots__/reads-app.uncached.test.ts.snap': '',
      [`${SERVER}.orig`]: '',
      'vitest.uncached.config.ts': '',
    });
    git(root, ['init', '-q']);
    expect(listUncachedTestFiles(root).sort()).toEqual([SERVER, TRANSPOSED].sort());
  });

  test('every tier project excludes node_modules, so a vendored suffixed file is in neither view', () => {
    const projects = (tierConfig.test?.projects ?? []) as Array<{ test?: { exclude?: string[] } }>;
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) expect(project.test?.exclude).toContain('**/node_modules/**');
  });
});
