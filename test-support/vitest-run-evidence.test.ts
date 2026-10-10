import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { type ChildRun, runChildWithSilenceBound } from './child-silence-bound.test-helper';
import { VITEST_RUN_EVIDENCE_OWNER_ENV } from './vitest-run-evidence';

const VITEST_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const BASE_MODULE = fileURLToPath(new URL('./vitest.base.ts', import.meta.url))
  .split(sep)
  .join('/');
const CHILD_SILENCE_BOUND_MS = 300_000;
const CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const BOUNDED_BY_CHILD_SILENCE = 0;

const RUN_IDENTITY_ENV = [
  VITEST_RUN_EVIDENCE_OWNER_ENV,
  'GITHUB_ACTIONS',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_JOB',
  'TURBO_HASH',
  'npm_lifecycle_event',
];

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const name of RUN_IDENTITY_ENV) delete env[name];
  return { ...env, ...overrides };
}

function runVitest(
  signal: AbortSignal,
  root: string,
  args: string[],
  overrides: Record<string, string>,
): Promise<ChildRun> {
  return runChildWithSilenceBound(process.execPath, [VITEST_CLI, ...args], {
    cwd: root,
    env: childEnv(overrides),
    signal,
    silenceBoundMs: CHILD_SILENCE_BOUND_MS,
    outputLimitBytes: CHILD_OUTPUT_LIMIT_BYTES,
  });
}

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const BASE_CONFIG = [
  `import { okVitestBase } from ${JSON.stringify(BASE_MODULE)};`,
  'export default {',
  '  ...okVitestBase,',
  "  test: { ...okVitestBase.test, globals: true, include: ['*.fixture.test.mjs'] },",
  '};',
  '',
].join('\n');

function writePackage(
  root: string,
  name: string,
  files: Record<string, string>,
  config: string,
): void {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, private: true })}\n`);
  writeFileSync(join(root, 'vitest.config.mjs'), config);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
  }
}

function fixturePackage(
  name: string,
  files: Record<string, string>,
  config: string = BASE_CONFIG,
): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-vitest-run-evidence-'));
  roots.push(root);
  writePackage(root, name, files, config);
  return root;
}

function errorAnnotations(run: ChildRun): string[] {
  return run.output.split('\n').filter((line) => line.startsWith('::error'));
}

type VitestJsonReport = {
  numTotalTests: number;
  numPassedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{ name: string }>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function reportDirectory(root: string): string[] {
  const dir = join(root, 'test-results');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

const ALL_SKIP = {
  'all-skip.fixture.test.mjs': [
    "test.skip('skipped where it is declared', () => { expect(1).toBe(1); });",
    "test('skips itself at runtime', (ctx) => { ctx.skip(); expect(1).toBe(2); });",
    "test.todo('not written yet');",
    '',
  ].join('\n'),
};

const ONE_EXECUTED = {
  'executed.fixture.test.mjs': "test('executes', () => { expect(1).toBe(1); });\n",
};

const IMPORT_FAILS = {
  'import-fails.fixture.test.mjs': [
    "import './no-module-is-named-this.mjs';",
    "test('never collected', () => { expect(1).toBe(1); });",
    '',
  ].join('\n'),
};

const NO_TEST_NAMED = 'no fixture test is named this';

describe('on GitHub Actions, a Vitest run that executed no test fails', () => {
  test(
    'a package whose every test skips fails with one error annotation naming the package, the script and the counts',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/all-skip', ALL_SKIP);
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain('@ok-fixture/all-skip');
      expect(annotations[0]).toContain('script test:unit');
      expect(annotations[0]).toContain(
        'the run executed no test (collected 3: 2 skipped, 1 todo, 0 unfinished; 1 file)',
      );
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a name filter that matches no test fails the same way and names the filter',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/filtered', ONE_EXECUTED);
      const run = await runVitest(signal, root, ['run', '-t', NO_TEST_NAMED], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain('@ok-fixture/filtered');
      expect(annotations[0]).toContain('script test:unit');
      expect(annotations[0]).toContain(
        `the run executed no test (collected 1: 1 skipped, 0 todo, 0 unfinished; 1 file; name filter /${NO_TEST_NAMED}/)`,
      );
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a file filter that selects no file fails even when the caller passes --passWithNoTests',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/no-file', ONE_EXECUTED);
      const run = await runVitest(
        signal,
        root,
        ['run', '--passWithNoTests', 'no-fixture-file-is-named-this'],
        {
          GITHUB_ACTIONS: 'true',
          npm_lifecycle_event: 'test:unit',
        },
      );
      expect(run.signal).toBeNull();
      expect(run.output).toContain('No test files found, exiting with code 0');
      expect(run.status, run.output).toBe(1);
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain(
        'the run executed no test (collected 0: 0 skipped, 0 todo, 0 unfinished; 0 files)',
      );
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a package with one executed test passes without an annotation',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/executed', ONE_EXECUTED);
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('1 passed (1)');
      expect(errorAnnotations(run)).toEqual([]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a run whose one executed test fails counts it as executed, so only the failure is annotated',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/failing', {
        'failing.fixture.test.mjs':
          "test('asserts something false', () => { expect(1).toBe(2); });\n",
      });
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('1 failed (1)');
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain('title=failing.fixture.test.mjs > asserts something false');
      expect(annotations[0]).not.toContain('executed no test');
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a run whose every file fails to import is red from the import failure alone, with no executed-no-test annotation',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/import-fails', IMPORT_FAILS);
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('no-module-is-named-this.mjs');
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain('import-fails.fixture.test.mjs');
      expect(annotations[0]).not.toContain('executed no test');
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a run where one file fails to import and another skips every test still names the skips',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/import-fails-beside-skips', {
        ...IMPORT_FAILS,
        ...ALL_SKIP,
      });
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const executedNothing = errorAnnotations(run).filter((line) =>
        line.includes('title=Vitest executed no test'),
      );
      expect(executedNothing, run.output).toHaveLength(1);
      expect(executedNothing[0]).toContain(
        'the run executed no test (collected 3: 2 skipped, 1 todo, 0 unfinished; 2 files)',
      );
    },
    BOUNDED_BY_CHILD_SILENCE,
  );
});

describe('off GitHub Actions, the same runs end as before and each writes its report', () => {
  test(
    'the all-skip, the filtered and the executed runs exit 0 and leave a Vitest JSON report of what ran',
    async ({ signal }) => {
      const allSkip = fixturePackage('@ok-fixture/all-skip', ALL_SKIP);
      const filtered = fixturePackage('@ok-fixture/filtered', ONE_EXECUTED);
      const ran = fixturePackage('@ok-fixture/executed', ONE_EXECUTED);
      const script = { npm_lifecycle_event: 'test:unit' };
      const runs = await Promise.all([
        runVitest(signal, allSkip, ['run'], script),
        runVitest(signal, filtered, ['run', '-t', NO_TEST_NAMED], script),
        runVitest(signal, ran, ['run'], script),
      ]);
      for (const run of runs) {
        expect(run.signal).toBeNull();
        expect(run.status, run.output).toBe(0);
        expect(errorAnnotations(run)).toEqual([]);
      }
      const reports = [allSkip, filtered, ran].map((root) =>
        readJson<VitestJsonReport>(join(root, 'test-results', 'vitest-test-unit.json')),
      );
      expect(
        reports.map(({ numTotalTests, numPassedTests, numPendingTests, numTodoTests }) => ({
          numTotalTests,
          numPassedTests,
          numPendingTests,
          numTodoTests,
        })),
      ).toEqual([
        { numTotalTests: 3, numPassedTests: 0, numPendingTests: 2, numTodoTests: 1 },
        { numTotalTests: 1, numPassedTests: 0, numPendingTests: 1, numTodoTests: 0 },
        { numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numTodoTests: 0 },
      ]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );
});

describe('each run names its report after the script that ran it and records where it came from', () => {
  test(
    'a script run writes vitest-<script>.json with its colons mapped to hyphens, and its provenance beside it',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/provenance', ONE_EXECUTED);
      const run = await runVitest(signal, root, ['run'], {
        npm_lifecycle_event: 'test:integration:shard1',
        TURBO_HASH: 'f00dfeedcafe0123',
        GITHUB_RUN_ID: '4242',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_JOB: 'test-shard',
      });
      expect(run.status, run.output).toBe(0);
      expect(reportDirectory(root)).toEqual([
        'vitest-test-integration-shard1.json',
        'vitest-test-integration-shard1.provenance.json',
      ]);
      expect(
        readJson(join(root, 'test-results', 'vitest-test-integration-shard1.provenance.json')),
      ).toEqual({
        report: 'vitest-test-integration-shard1.json',
        package: '@ok-fixture/provenance',
        script: 'test:integration:shard1',
        config: 'vitest.config.mjs',
        turboHash: 'f00dfeedcafe0123',
        runId: '4242',
        runAttempt: '2',
        job: 'test-shard',
      });
      const report = readJson<VitestJsonReport>(
        join(root, 'test-results', 'vitest-test-integration-shard1.json'),
      );
      expect(report.testResults.map(({ name }) => basename(name))).toEqual([
        'executed.fixture.test.mjs',
      ]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'on GitHub Actions, two direct calls with no package script in one package write two distinct reports, each with its own provenance',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/direct', ONE_EXECUTED);
      const first = await runVitest(signal, root, ['run'], { GITHUB_ACTIONS: 'true' });
      const second = await runVitest(signal, root, ['run'], { GITHUB_ACTIONS: 'true' });
      expect(first.status, first.output).toBe(0);
      expect(second.status, second.output).toBe(0);
      const files = reportDirectory(root);
      const reports = files.filter((file) => !file.endsWith('.provenance.json'));
      expect(reports).toHaveLength(2);
      for (const report of reports) expect(report).toMatch(/^vitest-direct-.+\.json$/);
      expect(files).toEqual(
        reports.flatMap((report) => [report, report.replace(/\.json$/, '.provenance.json')]).sort(),
      );
      for (const report of reports) {
        expect(
          readJson(join(root, 'test-results', report.replace(/\.json$/, '.provenance.json'))),
        ).toEqual({
          report,
          package: '@ok-fixture/direct',
          script: null,
          config: 'vitest.config.mjs',
          turboHash: null,
          runId: null,
          runAttempt: null,
          job: null,
        });
      }
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'off GitHub Actions, a direct call with no package script writes no report, while a script run in the same package still does',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/direct-local', ONE_EXECUTED);
      const direct = await runVitest(signal, root, ['run'], {});
      expect(direct.status, direct.output).toBe(0);
      expect(direct.output).toContain('1 passed (1)');
      expect(reportDirectory(root)).toEqual([]);
      const scripted = await runVitest(signal, root, ['run'], { npm_lifecycle_event: 'test' });
      expect(scripted.status, scripted.output).toBe(0);
      expect(reportDirectory(root)).toEqual(['vitest-test.json', 'vitest-test.provenance.json']);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );
});

function nestedRunFixture(innerRoot: string): string {
  return [
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `const INNER = ${JSON.stringify(innerRoot)};`,
    "test('an all-skip Vitest run started from this test inherits GitHub Actions and still passes, writing no report', () => {",
    `  const inner = spawnSync(process.execPath, [${JSON.stringify(VITEST_CLI)}, 'run'], { cwd: INNER, env: process.env, encoding: 'utf8', timeout: ${CHILD_SILENCE_BOUND_MS / 2} });`,
    "  expect(process.env.GITHUB_ACTIONS).toBe('true');",
    "  expect(inner.status, inner.stdout + '\\n' + inner.stderr).toBe(0);",
    "  expect(existsSync(join(INNER, 'test-results'))).toBe(false);",
    '});',
    '',
  ].join('\n');
}

function projectsConfig(names: string[]): string {
  return [
    `import { okVitestBase } from ${JSON.stringify(BASE_MODULE)};`,
    'const project = (name) => ({',
    '  ...okVitestBase,',
    "  test: { ...okVitestBase.test, globals: true, name, include: [name + '/*.fixture.test.mjs'] },",
    '});',
    `export default { test: { projects: ${JSON.stringify(names)}.map(project) } };`,
    '',
  ].join('\n');
}

const OWN_JSON_REPORTER_CONFIG = [
  `import { okVitestBase } from ${JSON.stringify(BASE_MODULE)};`,
  'export default {',
  '  ...okVitestBase,',
  '  test: {',
  '    ...okVitestBase.test,',
  '    globals: true,',
  "    include: ['*.fixture.test.mjs'],",
  "    reporters: ['default', 'json'],",
  "    outputFile: { json: 'test-results/own-report.json' },",
  '  },',
  '};',
  '',
].join('\n');

describe('only the outermost Vitest run applies the floor and writes a report', () => {
  test(
    'a Vitest run a test starts inherits the outer run, so it applies no floor and writes no report while the outer run keeps both',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/outer', {});
      const inner = join(root, 'inner');
      mkdirSync(inner);
      writePackage(inner, '@ok-fixture/inner', ALL_SKIP, BASE_CONFIG);
      writeFileSync(join(root, 'nested.fixture.test.mjs'), nestedRunFixture(inner));
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(0);
      expect(errorAnnotations(run)).toEqual([]);
      expect(reportDirectory(root)).toEqual([
        'vitest-test-unit.json',
        'vitest-test-unit.provenance.json',
      ]);
      expect(reportDirectory(inner)).toEqual([]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a run whose projects each carry the plugin, as the uncached tier does, writes one report and applies the floor once',
    async ({ signal }) => {
      const root = fixturePackage(
        '@ok-fixture/projects',
        {
          'first/all-skip.fixture.test.mjs': ALL_SKIP['all-skip.fixture.test.mjs'],
          'second/all-skip.fixture.test.mjs': ALL_SKIP['all-skip.fixture.test.mjs'],
        },
        projectsConfig(['first', 'second']),
      );
      const run = await runVitest(signal, root, ['run'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:uncached',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const annotations = errorAnnotations(run);
      expect(annotations, run.output).toHaveLength(1);
      expect(annotations[0]).toContain(
        'the run executed no test (collected 6: 4 skipped, 2 todo, 0 unfinished; 2 files)',
      );
      expect(reportDirectory(root)).toEqual([
        'vitest-test-uncached.json',
        'vitest-test-uncached.provenance.json',
      ]);
      expect(
        readJson<VitestJsonReport>(join(root, 'test-results', 'vitest-test-uncached.json'))
          .numTotalTests,
      ).toBe(6);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'vitest list executes nothing by design, so on GitHub Actions it stays green and writes no report',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/list', ALL_SKIP);
      const run = await runVitest(signal, root, ['list'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('skips itself at runtime');
      expect(errorAnnotations(run)).toEqual([]);
      expect(reportDirectory(root)).toEqual([]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );
});

describe('the report and the floor sit beside the configured reporters', () => {
  test(
    'a config that writes its own JSON report still writes it, and the run report lands beside it',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/own-report', ONE_EXECUTED, OWN_JSON_REPORTER_CONFIG);
      const run = await runVitest(signal, root, ['run'], { npm_lifecycle_event: 'test:node' });
      expect(run.status, run.output).toBe(0);
      expect(reportDirectory(root)).toEqual([
        'own-report.json',
        'vitest-test-node.json',
        'vitest-test-node.provenance.json',
      ]);
      for (const file of ['own-report.json', 'vitest-test-node.json']) {
        expect(
          readJson<VitestJsonReport>(join(root, 'test-results', file)).testResults.map(({ name }) =>
            basename(name),
          ),
        ).toEqual(['executed.fixture.test.mjs']);
      }
    },
    BOUNDED_BY_CHILD_SILENCE,
  );

  test(
    'a --reporter flag replaces the configured reporters but drops neither the report nor the floor',
    async ({ signal }) => {
      const root = fixturePackage('@ok-fixture/reporter-flag', ALL_SKIP);
      const run = await runVitest(signal, root, ['run', '--reporter=dot'], {
        GITHUB_ACTIONS: 'true',
        npm_lifecycle_event: 'test:unit',
      });
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(errorAnnotations(run), run.output).toHaveLength(1);
      expect(reportDirectory(root)).toEqual([
        'vitest-test-unit.json',
        'vitest-test-unit.provenance.json',
      ]);
    },
    BOUNDED_BY_CHILD_SILENCE,
  );
});
