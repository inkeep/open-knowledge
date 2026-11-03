import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  annotationTitle,
  GITHUB_TITLE_LIMIT,
  sourcePath,
} from '../../../../test-support/playwright-final-failure-annotations.ts';
import { parseWorkflowCommands } from '../../../../test-support/workflow-commands.test-helper.ts';

const DESKTOP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OK_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURE_CONFIG = fileURLToPath(
  new URL('./fixtures/final-failure-annotations/playwright.config.ts', import.meta.url),
);
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
const FIXTURE_FROM_DESKTOP = 'tests/support/fixtures/final-failure-annotations';
const FIXTURE_FROM_OK_ROOT = `packages/desktop/${FIXTURE_FROM_DESKTOP}`;
const RUN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 30_000;
const outputDirs: string[] = [];

afterEach(() => {
  for (const dir of outputDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FixtureRun {
  args?: string[];
  env?: Record<string, string>;
}

function runFixture(specs: string[], { args = [], env = {} }: FixtureRun = {}) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'final-failure-annotations-'));
  outputDirs.push(outputDir);
  const { OK_ANNOTATION_SOURCE_ROOT: _inherited, ...inherited } = process.env;
  const run = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '--config',
      FIXTURE_CONFIG,
      ...args,
      ...specs.map((spec) => `${spec}.fixture-spec.ts`),
    ],
    {
      cwd: DESKTOP_ROOT,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      env: {
        ...inherited,
        CI: '1',
        FORCE_COLOR: '0',
        GITHUB_WORKSPACE: OK_ROOT,
        FINAL_FAILURE_FIXTURE_OUTPUT_DIR: outputDir,
        ...env,
      },
    },
  );
  return { ...run, commands: parseWorkflowCommands(run.stdout) };
}

const fullTitleOf = (message: string) => message.split('\n')[0].replace(/^\d+\) /, '');

describe('a Playwright run under the final-failure reporter', () => {
  test(
    'gets one error per finally failed test, keyed on the spec, and nothing for a pass or a test that passed on retry',
    () => {
      const run = runFixture(['always-fails', 'helper-fails', 'two-errors', 'flaky', 'passes']);
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(1);
      expect(run.commands.map(({ command }) => command)).toEqual(['error', 'error', 'error']);
      const byFile = new Map(run.commands.map((command) => [command.properties.file, command]));

      const always = byFile.get(`${FIXTURE_FROM_OK_ROOT}/always-fails.fixture-spec.ts`);
      const alwaysTitle = `${FIXTURE_FROM_DESKTOP}/always-fails.fixture-spec.ts:4:3 › a suite, with a comma › fails on every try :: and says which`;
      expect(always?.properties).toMatchObject({ title: alwaysTitle, line: '5', col: '11' });
      const alwaysLines = always?.message.split('\n') ?? [];
      expect(alwaysLines[0]).toMatch(/^\d+\) /);
      expect(fullTitleOf(always?.message ?? '')).toBe(alwaysTitle);
      expect(alwaysLines[1]).toBe('Failed all 3 tries; the error below is from the last.');
      expect(always?.message).toContain('try 2 failed');
      expect(always?.message).not.toContain('try 0 failed');

      const helper = byFile.get(`${FIXTURE_FROM_OK_ROOT}/helper-fails.fixture-spec.ts`);
      expect(helper?.properties).toMatchObject({
        title: `${FIXTURE_FROM_DESKTOP}/helper-fails.fixture-spec.ts:4:1 › fails inside a helper`,
        line: '5',
        col: '3',
      });
      expect(helper?.message).toContain('the helper asserts something false');
      expect(helper?.message).toMatch(
        new RegExp(`^Thrown at ${FIXTURE_FROM_OK_ROOT}/failing-helper\\.ts:4:\\d+$`, 'm'),
      );

      const twoErrors = byFile.get(`${FIXTURE_FROM_OK_ROOT}/two-errors.fixture-spec.ts`);
      expect(twoErrors?.message).toContain('the first soft assertion');
      expect(twoErrors?.message.split('\n').at(-1)).toBe(
        '1 more error from the same try is in the job log.',
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'writes no workflow command when every test passed, one of them on retry',
    () => {
      const run = runFixture(['flaky', 'passes']);
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(0);
      expect(run.commands).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'still gives a test whose retry the run stopped its one error, beside the run error that stopped it',
    () => {
      const run = runFixture(['stopped-before-retry'], {
        args: ['--max-failures=1'],
        env: { FINAL_FAILURE_FIXTURE_ISOLATED_RETRIES: '1' },
      });
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(1);
      const spec = `${FIXTURE_FROM_OK_ROOT}/stopped-before-retry.fixture-spec.ts`;
      expect(run.commands.map(({ command, properties }) => [command, properties.file])).toEqual([
        ['error', spec],
        ['error', spec],
        ['error', undefined],
      ]);
      const stopped = run.commands.find(({ message }) => message.includes('the first try fails'));
      expect(stopped?.message.split('\n')[1]).toBe(
        'Failed 1 of 3 allowed tries; the run stopped before the rest.',
      );
      expect(run.commands.at(-1)?.message).not.toBe('');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'cuts a title longer than GitHub keeps to the limit, the same way every run, and keeps it whole in the message',
    () => {
      const run = runFixture(['long-title']);
      expect(run.signal, run.stderr).toBeNull();
      expect(run.commands.map(({ command }) => command)).toEqual(['error']);
      const [{ properties, message }] = run.commands;
      const full = fullTitleOf(message);
      expect(Array.from(full).length).toBeGreaterThan(GITHUB_TITLE_LIMIT);
      expect(full.endsWith('until the end')).toBe(true);
      expect(properties.title).toBe(
        `${Array.from(full)
          .slice(0, GITHUB_TITLE_LIMIT - 1)
          .join('')}…`,
      );
      expect(Array.from(properties.title)).toHaveLength(GITHUB_TITLE_LIMIT);
      expect(annotationTitle(full)).toBe(properties.title);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('an error outside any test', () => {
  test(
    'is a warning when every test passed and only a worker failed to tear down',
    () => {
      const run = runFixture(['teardown-fails']);
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(1);
      expect(run.commands.map(({ command, properties }) => [command, properties])).toEqual([
        ['warning', {}],
      ]);
      expect(run.commands[0].message).toContain('worker teardown failed on purpose');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is an error when a test also failed',
    () => {
      const run = runFixture(['teardown-fails', 'always-fails']);
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(1);
      const runLevel = run.commands.filter(({ properties }) => properties.file === undefined);
      expect(run.commands.map(({ command }) => command)).toEqual(['error', 'error']);
      expect(runLevel).toHaveLength(1);
      expect(runLevel[0].message).toContain('worker teardown failed on purpose');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is an error when no test ran because global setup failed',
    () => {
      const run = runFixture(['passes'], { env: { FINAL_FAILURE_FIXTURE_SETUP_FAILS: '1' } });
      expect(run.signal, run.stderr).toBeNull();
      expect(run.status, run.stdout).toBe(1);
      expect(run.commands.map(({ command, properties }) => [command, properties])).toEqual([
        ['error', {}],
      ]);
      expect(run.commands[0].message).toContain('global setup failed on purpose');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the annotation file path', () => {
  const spec = (root: string, join: (...parts: string[]) => string) =>
    join(root, 'packages', 'desktop', 'tests', 'smoke', 'launch.e2e.ts');

  test('is the repo path with forward slashes on Windows', () => {
    const okRoot = 'C:\\work\\repo\\public\\open-knowledge';
    expect(
      sourcePath(spec(okRoot, path.win32.join), {
        okRoot,
        workspace: 'C:\\work\\repo',
        override: undefined,
        pathApi: path.win32,
      }),
    ).toBe('public/open-knowledge/packages/desktop/tests/smoke/launch.e2e.ts');
  });

  test('is the repo path from the mirror export when the step names the source root, and the export path when it does not', () => {
    const okRoot = '/work/repo/.mirror-output/desktop-export';
    const roots = { okRoot, workspace: '/work/repo', pathApi: path.posix };
    expect(
      sourcePath(spec(okRoot, path.posix.join), { ...roots, override: 'public/open-knowledge' }),
    ).toBe('public/open-knowledge/packages/desktop/tests/smoke/launch.e2e.ts');
    expect(sourcePath(spec(okRoot, path.posix.join), { ...roots, override: undefined })).toBe(
      '.mirror-output/desktop-export/packages/desktop/tests/smoke/launch.e2e.ts',
    );
  });

  test('is relative to the subtree when the subtree is the workspace, as in the public repository', () => {
    const okRoot = '/work/open-knowledge';
    expect(
      sourcePath(spec(okRoot, path.posix.join), {
        okRoot,
        workspace: okRoot,
        override: undefined,
        pathApi: path.posix,
      }),
    ).toBe('packages/desktop/tests/smoke/launch.e2e.ts');
  });
});
