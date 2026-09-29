import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Reporter, TestModule } from 'vitest/node';
import tierConfig from '../vitest.uncached.config';
import { uncachedTierFloor } from './uncached-tier-floor';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VITEST_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const FLOOR_MODULE = fileURLToPath(new URL('./uncached-tier-floor.ts', import.meta.url));
const CHILD_BUDGET_MS = 50_000;
const TEST_BUDGET_MS = 60_000;

const AUTHOR_RULE =
  'A tier test must execute wherever the tier runs; if its subject is absent from the public mirror, name the file <name>.private.uncached.test.ts; never skip a test, or condition its definition or body, on a presence probe.';
const REFUSED_SKIPS =
  /vitest\.uncached\.config\.ts: the tier fails this run because not every collected test executed \(executed (\d+) of (\d+);/;
const REFUSAL_HEAD = 'vitest.uncached.config.ts: the tier fails this run because';
const AUTHOR_SKIP_PART = /^(\d+ skipped|\d+ todo|skipped suite ".*" holds no test)$/;
const AUTHOR_SKIPS_IN_HEAD = /; [1-9]\d* skipped, \d+ todo, \d+ unfinished;/;

type ChildRun = { status: number | null; signal: NodeJS.Signals | null; output: string };

function runVitest(cwd: string, config: string, args: string[]): Promise<ChildRun> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [VITEST_CLI, 'run', '--config', config, ...args],
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        timeout: CHILD_BUDGET_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolveRun({
          status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          signal: error?.signal ?? null,
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

function runRealTier(args: string[]): Promise<ChildRun> {
  return runVitest(OK_ROOT, 'vitest.uncached.config.ts', args);
}

function refusedCounts(run: ChildRun): { executed: number; collected: number } {
  const match = run.output.match(REFUSED_SKIPS);
  expect(match, `expected the tier's refusal line in:\n${run.output}`).not.toBeNull();
  return { executed: Number(match?.[1]), collected: Number(match?.[2]) };
}

function floorRefusal(run: ChildRun): string {
  const start = run.output.indexOf(REFUSAL_HEAD);
  expect(start, `expected the floor's refusal in:\n${run.output}`).toBeGreaterThanOrEqual(0);
  return run.output.slice(start);
}

function authorAttributions(
  refusal: string,
  files: string[],
): Record<string, string[] | 'not named by the floor'> {
  const rows = refusal.split('\n').map((row) => row.trimStart());
  return Object.fromEntries(
    files.map((file) => {
      if (!refusal.includes(file)) return [file, 'not named by the floor'];
      const prefix = `${file}: `;
      const lines = rows
        .filter((row) => row.startsWith(prefix))
        .map((row) => row.slice(prefix.length).split('; '));
      return [
        file,
        lines.flatMap((parts) =>
          parts.length === 1 && parts[0] === 'no test executed'
            ? parts
            : parts.filter((part) => AUTHOR_SKIP_PART.test(part)),
        ),
      ];
    }),
  );
}

describe('the real uncached tier fails a run in which a collected test did not execute', () => {
  test(
    'a name filter that matches no test skips every test, and the run fails with the counts and the rule',
    async () => {
      const run = await runRealTier(['-t', 'no uncached tier test is named this']);
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const { executed, collected } = refusedCounts(run);
      expect(executed).toBe(0);
      expect(collected).toBeGreaterThan(0);
      expect(run.output).toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a name filter that runs some tests and skips the rest fails for the ones it skipped',
    async () => {
      const run = await runRealTier(['-t', 'rule is registered']);
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      const { executed, collected } = refusedCounts(run);
      expect(
        executed,
        'precondition: -t "rule is registered" must still select at least one tier test, the ok-rules registration tests',
      ).toBeGreaterThan(0);
      expect(executed).toBeLessThan(collected);
      expect(run.output).toMatch(/-t "rule is registered" skipped tests by name/);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a run that selects no file fails, even when the caller passes --passWithNoTests',
    async () => {
      const run = await runRealTier(['--passWithNoTests', 'no-uncached-tier-file-is-named-this']);
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(
        'vitest.uncached.config.ts: the tier fails this run because it ran no test file',
      );
    },
    TEST_BUDGET_MS,
  );

  test('every project of the real tier config carries the floor', () => {
    const projects = (tierConfig.test?.projects ?? []) as Array<{ plugins?: unknown[] }>;
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      const names = (project.plugins ?? [])
        .flat(Number.POSITIVE_INFINITY)
        .map((plugin) => (plugin as { name?: unknown } | null)?.name);
      expect(names).toContain('ok:uncached-tier-floor');
    }
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function fixtureTier(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-uncached-tier-floor-'));
  roots.push(root);
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    [
      `import { uncachedTierFloor } from ${JSON.stringify(FLOOR_MODULE.split(sep).join('/'))};`,
      "export default { plugins: [uncachedTierFloor()], test: { globals: true, include: ['*.fixture.test.mjs'] } };",
      '',
    ].join('\n'),
  );
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

function runFixtureTier(root: string, args: string[] = []): Promise<ChildRun> {
  return runVitest(root, join(root, 'vitest.config.mjs'), args);
}

const CONTROL = "test('control executes', () => { expect(1).toBe(1); });\n";
const PRESENCE_PROBE = [
  'const SUBJECT = null;',
  "describe.runIf(SUBJECT !== null)('reads a subject only the monorepo has', () => {",
  "  test('matches the subject', () => { expect(SUBJECT).toBe(1); });",
  '});',
  '',
].join('\n');

describe('the floor, run by Vitest itself over fixture files', () => {
  test(
    'a clean run passes and prints what it executed',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'second.fixture.test.mjs':
          "describe('suite', () => { test('a', () => { expect(1).toBe(1); }); test('b', () => { expect(2).toBe(2); }); });\n",
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(
        'uncached tier: every collected test executed (3 of 3; 3 passed, 0 failed; 2 files).',
      );
      expect(run.output).not.toContain('the tier fails this run');
    },
    TEST_BUDGET_MS,
  );

  test(
    'a file holding only an empty skipped suite fails the run beside a passing control, though no leaf test skipped',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'empty-suite.fixture.test.mjs': "describe.skip('empty reader corpus', () => {});\n",
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(refusedCounts(run)).toEqual({ executed: 1, collected: 1 });
      expect(run.output).toContain(
        'empty-suite.fixture.test.mjs: no test executed; skipped suite "empty reader corpus" holds no test',
      );
      expect(run.output).not.toMatch(/control\.fixture\.test\.mjs: /);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a presence-probe skip, a todo, a runtime skip and a focused sibling each fail the run, and the control does not',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'probe.fixture.test.mjs': PRESENCE_PROBE,
        'todo.fixture.test.mjs':
          "test('executes', () => { expect(1).toBe(1); });\ntest.todo('not written yet');\n",
        'runtime-skip.fixture.test.mjs':
          "test('skips itself', (ctx) => { ctx.skip(); expect(1).toBe(2); });\ntest('executes', () => { expect(1).toBe(1); });\n",
        'focused.fixture.test.mjs':
          "test.only('focused', () => { expect(1).toBe(1); });\ntest('silently skipped sibling', () => { expect(1).toBe(2); });\n",
      });
      const run = await runFixtureTier(root, ['--allowOnly']);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('probe.fixture.test.mjs: no test executed; 1 skipped');
      expect(run.output).toContain('todo.fixture.test.mjs: 1 todo');
      expect(run.output).toContain('runtime-skip.fixture.test.mjs: 1 skipped');
      expect(run.output).toContain('focused.fixture.test.mjs: 1 skipped');
      expect(run.output).not.toMatch(/control\.fixture\.test\.mjs: /);
      expect(run.output).toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a --reporter flag cannot drop the floor, because the floor is not a configured reporter',
    async () => {
      const root = fixtureTier({ 'probe.fixture.test.mjs': PRESENCE_PROBE });
      const run = await runFixtureTier(root, ['--reporter=dot']);
      expect(run.status, run.output).toBe(1);
      expect(refusedCounts(run)).toEqual({ executed: 0, collected: 1 });
    },
    TEST_BUDGET_MS,
  );

  test(
    'a real failure still fails the run, and the floor reports it as executed rather than skipped',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'failing.fixture.test.mjs':
          "test('asserts something false', () => { expect(1).toBe(2); });\n",
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(
        'uncached tier: every collected test executed (2 of 2; 1 passed, 1 failed; 2 files).',
      );
      expect(run.output).not.toContain('the tier fails this run');
      expect(run.output).toContain('AssertionError');
    },
    TEST_BUDGET_MS,
  );

  test(
    'a file that fails to load and a suite whose beforeAll throws are refused as those failures, not as author skips and not with the author rule',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'broken.fixture.test.mjs': [
          "import { missing } from './does-not-exist.mjs';",
          "test('never collected', () => { expect(missing).toBe(1); });",
          '',
        ].join('\n'),
        'hook.fixture.test.mjs': [
          "describe('suite whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  test('a', () => { expect(1).toBe(1); });",
          "  test('b', () => { expect(1).toBe(1); });",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(run.output).not.toContain('uncached tier: every collected test executed');
      const refusal = floorRefusal(run);
      expect(
        authorAttributions(refusal, ['broken.fixture.test.mjs', 'hook.fixture.test.mjs']),
      ).toEqual({ 'broken.fixture.test.mjs': [], 'hook.fixture.test.mjs': [] });
      expect(refusal).not.toMatch(AUTHOR_SKIPS_IN_HEAD);
      expect(refusal).toContain(
        '(executed 1 of 3; 0 skipped, 0 todo, 0 unfinished; 2 stopped by a failure; 3 files).',
      );
      expect(refusal).not.toMatch(/control\.fixture\.test\.mjs: /);
      expect(run.output).not.toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a describe body that throws, a module-scope beforeAll that throws, and suites under a failed beforeAll are refused as those failures, not as author skips',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'describe-body.fixture.test.mjs': [
          "describe('suite whose body throws', () => {",
          "  test('a', () => { expect(1).toBe(1); });",
          "  throw new Error('describe body boom');",
          '});',
          "test('sibling after', () => { expect(1).toBe(1); });",
          '',
        ].join('\n'),
        'module-before-all.fixture.test.mjs': [
          "beforeAll(() => { throw new Error('module beforeAll boom'); });",
          "test('a', () => { expect(1).toBe(1); });",
          "test('b', () => { expect(1).toBe(1); });",
          '',
        ].join('\n'),
        'nested-empty.fixture.test.mjs': [
          "describe('outer whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  test('a', () => { expect(1).toBe(1); });",
          "  describe('empty inner', () => {});",
          '});',
          '',
        ].join('\n'),
        'nested-hook.fixture.test.mjs': [
          "describe('outer', () => {",
          "  test('outer passes', () => { expect(1).toBe(1); });",
          "  describe('inner whose beforeAll throws', () => {",
          "    beforeAll(() => { throw new Error('inner beforeAll boom'); });",
          "    test('inner a', () => { expect(1).toBe(1); });",
          '  });',
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.signal).toBeNull();
      expect(run.status, run.output).toBe(1);
      expect(run.output).not.toContain('uncached tier: every collected test executed');
      const refusal = floorRefusal(run);
      expect(
        authorAttributions(refusal, [
          'describe-body.fixture.test.mjs',
          'module-before-all.fixture.test.mjs',
          'nested-empty.fixture.test.mjs',
          'nested-hook.fixture.test.mjs',
        ]),
      ).toEqual({
        'describe-body.fixture.test.mjs': [],
        'module-before-all.fixture.test.mjs': [],
        'nested-empty.fixture.test.mjs': [],
        'nested-hook.fixture.test.mjs': [],
      });
      expect(refusal).not.toMatch(AUTHOR_SKIPS_IN_HEAD);
      expect(run.output).not.toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a test.skip beside a suite whose beforeAll throws is the one author skip in its file, and the run still ends with the author rule',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'mixed.fixture.test.mjs': [
          "test.skip('author skip', () => { expect(1).toBe(1); });",
          "describe('suite whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  test('a', () => { expect(1).toBe(1); });",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(authorAttributions(floorRefusal(run), ['mixed.fixture.test.mjs'])).toEqual({
        'mixed.fixture.test.mjs': ['1 skipped'],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'author skips beside a failing test stay author skips, and the run ends with the author rule',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'fail-and-skip.fixture.test.mjs': [
          "test('asserts something false', () => { expect(1).toBe(2); });",
          "test.skip('author skip', () => { expect(1).toBe(1); });",
          "test('skips itself', (ctx) => { ctx.skip(); });",
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(authorAttributions(floorRefusal(run), ['fail-and-skip.fixture.test.mjs'])).toEqual({
        'fail-and-skip.fixture.test.mjs': ['2 skipped'],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'a file that registers no test stays an author miss with the author rule when, as in the tier, no --passWithNoTests is set',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'silent.fixture.test.mjs':
          "const SUBJECT = null;\nif (SUBJECT !== null) { test('reads the subject', () => { expect(SUBJECT).toBe(1); }); }\n",
        'empty-suite.fixture.test.mjs': "describe('empty reader corpus', () => {});\n",
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(
        authorAttributions(floorRefusal(run), [
          'silent.fixture.test.mjs',
          'empty-suite.fixture.test.mjs',
        ]),
      ).toEqual({
        'silent.fixture.test.mjs': ['no test executed'],
        'empty-suite.fixture.test.mjs': ['no test executed'],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'a runtime ctx.skip() stays an author skip with the author rule, even when a hook in its suite or module fails',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'probe-in-before-each.fixture.test.mjs': [
          'const SUBJECT = null;',
          "describe('probe in beforeEach', () => {",
          '  beforeEach((ctx) => { if (SUBJECT === null) ctx.skip(); });',
          "  test('a', () => { expect(SUBJECT).toBe(1); });",
          '});',
          '',
        ].join('\n'),
        'probe-in-before-each-after-all-throws.fixture.test.mjs': [
          'const SUBJECT = null;',
          "describe('probe in beforeEach, afterAll throws', () => {",
          '  beforeEach((ctx) => { if (SUBJECT === null) ctx.skip(); });',
          "  afterAll(() => { throw new Error('afterAll boom'); });",
          "  test('a', () => { expect(SUBJECT).toBe(1); });",
          '});',
          '',
        ].join('\n'),
        'runtime-skip-after-all-throws.fixture.test.mjs': [
          "describe('beforeAll passes, afterAll throws', () => {",
          '  beforeAll(() => {});',
          "  afterAll(() => { throw new Error('afterAll boom'); });",
          "  test('skips itself', (ctx) => { ctx.skip(); });",
          '});',
          '',
        ].join('\n'),
        'runtime-skip-module-after-all-throws.fixture.test.mjs': [
          "afterAll(() => { throw new Error('module afterAll boom'); });",
          "test('skips itself', (ctx) => { ctx.skip(); });",
          "test('executes', () => { expect(1).toBe(1); });",
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(
        authorAttributions(floorRefusal(run), [
          'probe-in-before-each.fixture.test.mjs',
          'probe-in-before-each-after-all-throws.fixture.test.mjs',
          'runtime-skip-after-all-throws.fixture.test.mjs',
          'runtime-skip-module-after-all-throws.fixture.test.mjs',
        ]),
      ).toEqual({
        'probe-in-before-each.fixture.test.mjs': ['1 skipped'],
        'probe-in-before-each-after-all-throws.fixture.test.mjs': ['1 skipped'],
        'runtime-skip-after-all-throws.fixture.test.mjs': ['1 skipped'],
        'runtime-skip-module-after-all-throws.fixture.test.mjs': ['1 skipped'],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'a test.skip or an empty describe.skip under a beforeAll that throws stays an author skip, and the run ends with the author rule',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'skip-inside.fixture.test.mjs': [
          "describe('suite whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  test.skip('author skip inside', () => { expect(1).toBe(1); });",
          "  test('a', () => { expect(1).toBe(1); });",
          '});',
          '',
        ].join('\n'),
        'nested-empty-skip.fixture.test.mjs': [
          "describe('outer whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  test('a', () => { expect(1).toBe(1); });",
          "  describe.skip('author-skipped empty inner', () => {});",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(
        authorAttributions(floorRefusal(run), [
          'skip-inside.fixture.test.mjs',
          'nested-empty-skip.fixture.test.mjs',
        ]),
      ).toEqual({
        'skip-inside.fixture.test.mjs': ['1 skipped'],
        'nested-empty-skip.fixture.test.mjs': [
          'skipped suite "outer whose beforeAll throws > author-skipped empty inner" holds no test',
        ],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'a captured ctx.skip() called in a beforeAll stays an author skip with the author rule, whether nothing failed or only a test beside it',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'captured.fixture.test.mjs': [
          'let captured;',
          "test('captures its context', (ctx) => { captured = ctx; expect(1).toBe(1); });",
          "describe('gated by a skip called in beforeAll', () => {",
          '  beforeAll(() => { captured.skip(); });',
          "  test('a', () => { expect(1).toBe(1); });",
          '});',
          '',
        ].join('\n'),
        'captured-beside-failure.fixture.test.mjs': [
          'let captured;',
          "test('captures its context', (ctx) => { captured = ctx; expect(1).toBe(1); });",
          "test('asserts something false', () => { expect(1).toBe(2); });",
          "describe('gated by a skip called in beforeAll', () => {",
          '  beforeAll(() => { captured.skip(); });',
          "  test('a', () => { expect(1).toBe(1); });",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(AUTHOR_RULE);
      expect(
        authorAttributions(floorRefusal(run), [
          'captured.fixture.test.mjs',
          'captured-beside-failure.fixture.test.mjs',
        ]),
      ).toEqual({
        'captured.fixture.test.mjs': ['1 skipped'],
        'captured-beside-failure.fixture.test.mjs': ['1 skipped'],
      });
    },
    TEST_BUDGET_MS,
  );

  test(
    'an empty suite a failed beforeAll stopped fails the run on its own, as that failure and without the author rule',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'only-empty-stopped.fixture.test.mjs': [
          "test('executes', () => { expect(1).toBe(1); });",
          "describe('outer whose beforeAll throws', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  describe('empty inner', () => {});",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(run.output).not.toContain('uncached tier: every collected test executed');
      expect(floorRefusal(run)).toContain(
        'only-empty-stopped.fixture.test.mjs: stopped suite "outer whose beforeAll throws > empty inner" holds no test',
      );
      expect(run.output).not.toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a file that registers no test keeps the author rule when all it holds is an empty suite a failed beforeAll stopped',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'stopped-suite-only.fixture.test.mjs': [
          "describe('outer', () => {",
          "  beforeAll(() => { throw new Error('beforeAll boom'); });",
          "  describe('empty inner', () => {});",
          '});',
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root);
      expect(run.status, run.output).toBe(1);
      expect(floorRefusal(run)).toContain(
        'stopped-suite-only.fixture.test.mjs: no test executed; stopped suite "outer > empty inner" holds no test',
      );
      expect(run.output).toContain(AUTHOR_RULE);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a file that registers no test fails the run beside a passing control, even under --passWithNoTests',
    async () => {
      const root = fixtureTier({
        'control.fixture.test.mjs': CONTROL,
        'silent.fixture.test.mjs':
          "const SUBJECT = null;\nif (SUBJECT !== null) { test('reads the subject', () => { expect(SUBJECT).toBe(1); }); }\n",
        'empty-suite.fixture.test.mjs': "describe('empty reader corpus', () => {});\n",
      });
      const run = await runFixtureTier(root, ['--passWithNoTests']);
      expect(run.status, run.output).toBe(1);
      expect(refusedCounts(run)).toEqual({ executed: 1, collected: 1 });
      expect(run.output).toContain('silent.fixture.test.mjs: no test executed');
      expect(run.output).toContain('empty-suite.fixture.test.mjs: no test executed');
      expect(run.output).not.toContain('uncached tier: every collected test executed');
      expect(run.output).not.toMatch(/control\.fixture\.test\.mjs: /);
    },
    TEST_BUDGET_MS,
  );

  test(
    'a run Vitest interrupted fails without blaming the tests it cancelled on the author',
    async () => {
      const root = fixtureTier({
        'bail.fixture.test.mjs': [
          "test('fails first', () => { expect(1).toBe(2); });",
          "test('cancelled a', () => { expect(1).toBe(1); });",
          "test('cancelled b', () => { expect(1).toBe(1); });",
          '',
        ].join('\n'),
      });
      const run = await runFixtureTier(root, ['--bail=1', '--no-file-parallelism']);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(
        'vitest.uncached.config.ts: the tier fails this run because Vitest interrupted it before it finished',
      );
      expect(run.output).not.toContain(AUTHOR_RULE);
      expect(run.output).not.toContain('uncached tier: every collected test executed');
    },
    TEST_BUDGET_MS,
  );
});

describe('the floor fails closed', () => {
  function installFloor(vitest: object): Reporter[] {
    const plugin = uncachedTierFloor();
    const configure = plugin.configureVitest as (context: { vitest: object }) => void;
    configure({ vitest });
    return (vitest as { config: { reporters: Reporter[] } }).config.reporters;
  }

  test('one Vitest instance gets one floor, however many of its projects carry the plugin', () => {
    const vitest = { config: { reporters: [], root: OK_ROOT, testNamePattern: undefined } };
    installFloor(vitest);
    expect(installFloor(vitest)).toHaveLength(1);
  });

  test('a result the floor cannot read fails the run instead of passing it', () => {
    const vitest = { config: { reporters: [], root: OK_ROOT, testNamePattern: undefined } };
    const [floor] = installFloor(vitest);
    const unreadable = {
      moduleId: join(OK_ROOT, 'unreadable.uncached.test.ts'),
      children: {
        *allTests() {
          yield {
            fullName: 'unreadable',
            options: { mode: 'run' },
            result: () => ({ state: 'lost' }),
          };
        },
        *allSuites() {},
      },
    } as unknown as TestModule;
    const previous = process.exitCode;
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      floor?.onTestRunEnd?.([unreadable], [], 'passed');
      expect(process.exitCode).toBe(1);
      expect(printed).toHaveBeenCalledWith(
        expect.stringContaining(
          'vitest.uncached.config.ts: the tier fails this run because it could not read the run\'s results: Error: test "unreadable" in unreadable.uncached.test.ts reports an unknown state',
        ),
      );
    } finally {
      process.exitCode = previous;
      printed.mockRestore();
    }
  });

  test('a reader that breaks on a changed Vitest API fails the run and keeps the error class and stack', () => {
    const vitest = { config: { reporters: [], root: OK_ROOT, testNamePattern: undefined } };
    const [floor] = installFloor(vitest);
    const drifted = {
      moduleId: join(OK_ROOT, 'drifted.uncached.test.ts'),
      children: { allTestCases: () => [] },
    } as unknown as TestModule;
    const previous = process.exitCode;
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      floor?.onTestRunEnd?.([drifted], [], 'passed');
      expect(process.exitCode).toBe(1);
      const message = String(printed.mock.calls[0]?.[0]);
      expect(message).toContain(
        "vitest.uncached.config.ts: the tier fails this run because it could not read the run's results: TypeError:",
      );
      expect(message).toMatch(/\n\s+at /);
    } finally {
      process.exitCode = previous;
      printed.mockRestore();
    }
  });
});
