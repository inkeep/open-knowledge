import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { okVitestBase } from '../test-support/vitest.base.ts';
import { gitCleanEnv } from './git-clean-env.mjs';
import {
  ALLOWLIST_PATH,
  CONVENTION_DOC,
  EXPIRY_WARNING_DAYS,
  expiringSoon,
  KNOWN_BUG_TAG,
  listTestFiles,
  loadAllowlist,
  MAX_HORIZON_DAYS,
  MIN_SIGNATURE_LITERAL,
  OK_ROOT,
  OWNERS,
  QUARANTINE_TAG,
  render,
  scanSource,
  scanTree,
  todayUtc,
  validate,
} from './known-reds.mjs';

const SCRIPT = fileURLToPath(new URL('./known-reds.mjs', import.meta.url));
const ISSUE = 'https://github.com/inkeep/agents-private/issues/1056';
const TODAY = '2026-10-01';
const NO_ALLOWLIST = { ciSkips: [] };

const vitestPin = ({
  tags = "['known-bug']",
  meta = `{ issue: '${ISSUE}', owner: 'get-main-green', until: '2026-10-15' }`,
  declare = 'test',
  body = 'await expectKnownBug(/row still visible/, async () => { expect(1).toBe(2); });',
} = {}) => `
import { expect, test } from 'vitest';
import { expectKnownBug } from '../../test-support/known-bug.vitest.test-helper';
${declare}('deleted file leaves the sidebar', { tags: ${tags}, meta: ${meta} }, async () => {
  ${body}
});
`;

const playwrightPin = (configure) => `
import { expect, test } from '@playwright/test';
import { expectKnownBug } from '../../../../test-support/known-bug.test-helper';
test.describe('sidebar', () => {
  ${configure}
  test('hide removes the row', {
    tag: '@known-bug',
    annotation: [
      { type: 'issue', description: '${ISSUE}' },
      { type: 'owner', description: 'get-main-green' },
      { type: 'until', description: '2026-10-15' },
    ],
  }, async ({ page }) => {
    await expectKnownBug(/unexpected value "visible"/, async () => {
      await expect(page.getByRole('treeitem')).toBeHidden();
    });
  });
});
`;

const rules = (scan) => scan.problems.map((problem) => problem.rule);
const ciSkipCount = (path, source) =>
  scanSource(path, source).gates.filter((gate) => gate.ci === 'skips-on-ci').length;

describe('known-reds scanner: pins and quarantines', () => {
  test('reads a Vitest pin with its fields and signature', () => {
    const scan = scanSource('packages/app/src/a.test.ts', vitestPin());
    expect(scan.problems).toEqual([]);
    expect(scan.pins).toEqual([
      {
        path: 'packages/app/src/a.test.ts',
        line: 4,
        runner: 'vitest',
        title: 'deleted file leaves the sidebar',
        issue: ISSUE,
        owner: 'get-main-green',
        until: '2026-10-15',
        signature: '/row still visible/',
      },
    ]);
  });

  test('a test without the known-bug tag is not a pin', () => {
    const scan = scanSource('packages/app/src/a.test.ts', vitestPin({ tags: "['slow']" }));
    expect(scan.pins).toEqual([]);
    expect(scan.problems).toEqual([]);
  });

  test('accepts a single-string tag', () => {
    expect(
      scanSource('packages/app/src/a.test.ts', vitestPin({ tags: "'known-bug'" })).pins,
    ).toHaveLength(1);
  });

  test('refuses a tag list the listing cannot read', () => {
    expect(
      rules(scanSource('packages/app/src/a.test.ts', vitestPin({ tags: 'PIN_TAGS' }))),
    ).toEqual(['tags-not-literal']);
  });

  test('refuses meta fields the listing cannot read', () => {
    const meta = `{ issue: ISSUE_URL, owner: 'get-main-green', until: '2026-10-15' }`;
    expect(rules(scanSource('packages/app/src/a.test.ts', vitestPin({ meta })))).toEqual([
      'fields-not-literal',
    ]);
  });

  test('a pin must assert through expectKnownBug', () => {
    const scan = scanSource(
      'packages/app/src/a.test.ts',
      vitestPin({ body: 'expect(1).toBe(2);' }),
    );
    expect(rules(scan)).toEqual(['pin-without-helper']);
  });

  test('a pin signature must be a regular-expression literal', () => {
    const body = "await expectKnownBug('row still visible', () => { expect(1).toBe(2); });";
    expect(rules(scanSource('packages/app/src/a.test.ts', vitestPin({ body })))).toEqual([
      'signature-not-literal',
    ]);
  });

  test.each(['/./', '/.*/', '/[a-z]+/', '/a.b.c/', '/.{10,20}/', '/\\w{2,10}/'])(
    'refuses the signature %s, which names no wrong outcome',
    (signature) => {
      const body = `await expectKnownBug(${signature}, () => { expect(1).toBe(2); });`;
      expect(rules(scanSource('packages/app/src/a.test.ts', vitestPin({ body })))).toEqual([
        'signature-too-broad',
      ]);
    },
  );

  test('accepts a signature with a literal run of the minimum length', () => {
    expect(MIN_SIGNATURE_LITERAL).toBe(4);
    for (const signature of ['/ENOENT/', '/\\d+ items/', '/Received: "visible"/i', '/\\{ab\\}/']) {
      const body = `await expectKnownBug(${signature}, () => { expect(1).toBe(2); });`;
      expect(rules(scanSource('packages/app/src/a.test.ts', vitestPin({ body })))).toEqual([]);
    }
  });

  test('a test tagged both known-bug and quarantine is refused', () => {
    const scan = scanSource(
      'packages/app/src/a.test.ts',
      vitestPin({ tags: "['known-bug', 'quarantine']" }),
    );
    expect(rules(scan)).toEqual(['pin-and-quarantine']);
  });

  test('reads a single-object Playwright annotation, and refuses a non-literal one', () => {
    const single = playwrightPin('test.describe.configure({ retries: 0 });').replace(
      /annotation: \[[\s\S]*?\],/,
      `annotation: { type: 'issue', description: '${ISSUE}' },`,
    );
    const singleScan = scanSource('packages/app/tests/stress/a.e2e.ts', single);
    expect(singleScan.problems).toEqual([]);
    expect(singleScan.pins[0]).toMatchObject({ issue: ISSUE });
    expect(singleScan.pins[0].owner).toBeUndefined();
    const nonLiteral = playwrightPin('test.describe.configure({ retries: 0 });').replace(
      `{ type: 'issue', description: '${ISSUE}' }`,
      "{ type: 'issue', description: ISSUE_URL }",
    );
    expect(rules(scanSource('packages/app/tests/stress/a.e2e.ts', nonLiteral))).toEqual([
      'fields-not-literal',
    ]);
  });

  test('a skipped pin is refused, because it checks nothing', () => {
    expect(
      rules(scanSource('packages/app/src/a.test.ts', vitestPin({ declare: 'test.skip' }))),
    ).toEqual(['pin-not-run']);
  });

  test('a known-bug tag on a describe is refused', () => {
    const source = `
import { describe, test } from 'vitest';
describe('sidebar', { tags: ['known-bug'] }, () => {
  test('x', () => {});
});
`;
    expect(rules(scanSource('packages/app/src/a.test.ts', source))).toEqual(['tag-on-describe']);
  });

  test('a Playwright pin runs with retries: 0 in its describe', () => {
    const ok = scanSource(
      'packages/app/tests/stress/a.e2e.ts',
      playwrightPin('test.describe.configure({ retries: 0 });'),
    );
    expect(ok.problems).toEqual([]);
    expect(ok.pins).toHaveLength(1);
    expect(ok.pins[0]).toMatchObject({
      runner: 'playwright',
      issue: ISSUE,
      owner: 'get-main-green',
      until: '2026-10-15',
    });
    expect(rules(scanSource('packages/app/tests/stress/a.e2e.ts', playwrightPin('')))).toEqual([
      'pin-retries',
    ]);
    expect(
      rules(
        scanSource(
          'packages/app/tests/stress/a.e2e.ts',
          playwrightPin('test.describe.configure({ retries: 2 });'),
        ),
      ),
    ).toEqual(['pin-retries']);
  });

  test('the nearest retries setting decides, not an outer one', () => {
    const source = `test.describe.configure({ retries: 0 });\n${playwrightPin('test.describe.configure({ retries: 1 });')}`;
    expect(rules(scanSource('packages/app/tests/stress/a.e2e.ts', source))).toEqual([
      'pin-retries',
    ]);
    const outerOnly = `test.describe.configure({ retries: 0 });\n${playwrightPin('')}`;
    expect(rules(scanSource('packages/app/tests/stress/a.e2e.ts', outerOnly))).toEqual([]);
  });

  test('a quarantine is declared skipped', () => {
    const quarantine = (declare) => `
import { test } from 'vitest';
${declare}('flaky under load', { tags: ['quarantine'], meta: { issue: '${ISSUE}', owner: 'get-main-green', until: '2026-10-15' } }, () => {});
`;
    const skipped = scanSource('packages/app/src/a.test.ts', quarantine('test.skip'));
    expect(skipped.problems).toEqual([]);
    expect(skipped.quarantines).toHaveLength(1);
    expect(skipped.notRun).toEqual([]);
    expect(rules(scanSource('packages/app/src/a.test.ts', quarantine('test')))).toEqual([
      'quarantine-runs',
    ]);
  });

  test('uses the runner-appropriate tag spelling', () => {
    expect(KNOWN_BUG_TAG).toBe('known-bug');
    expect(QUARANTINE_TAG).toBe('quarantine');
    const playwrightWithVitestSpelling = playwrightPin(
      'test.describe.configure({ retries: 0 });',
    ).replace("tag: '@known-bug'", "tag: 'known-bug'");
    expect(
      scanSource('packages/app/tests/stress/a.e2e.ts', playwrightWithVitestSpelling).pins,
    ).toEqual([]);
  });
});

describe('known-reds scanner: bare expected-failure markers', () => {
  test.each([
    ["test.fails('x', () => { expect(1).toBe(2); });", 'packages/app/src/a.test.ts'],
    ["it.fails('x', () => { expect(1).toBe(2); });", 'packages/app/src/a.test.ts'],
    ["test('x', { fails: true }, () => { expect(1).toBe(2); });", 'packages/app/src/a.test.ts'],
    ["test('x', async () => { test.fail(); });", 'packages/app/tests/stress/a.e2e.ts'],
    ["test.fail('x', async () => {});", 'packages/app/tests/stress/a.e2e.ts'],
  ])('refuses %s', (source, path) => {
    expect(rules(scanSource(path, source))).toEqual(['bare-expected-failure']);
  });

  test.each([
    "import assert from 'node:assert'; test('x', () => { assert.fail('unreachable'); });",
    "test('x', () => { deferred.fail(new Error('x')); });",
    "test('x', () => { expect(['test.only(', 'test.fail(']).toHaveLength(2); });",
    "test('x', () => { report({ fails: 3 }); });",
  ])('does not mistake %s for a marker', (source) => {
    expect(scanSource('packages/app/src/a.test.ts', source).problems).toEqual([]);
  });
});

describe('known-reds scanner: CI-keyed skips', () => {
  test.each([
    "test.skip(IS_CI, 'x');",
    "test.skip(isCI, 'x');",
    "test.skip(CI, 'x');",
    "test.skip(process.env.CI === 'true', 'x');",
    'test.skip(process.env.GITHUB_ACTIONS, "x");',
    'test.skip(process.env.GITHUB_RUN_ID, "x");',
    'test.skip(process.env.GITHUB_WORKFLOW, "x");',
    ['test.skip(', '  IS_CI,', "  'disabled on CI',", ');'].join('\n'),
  ])('finds the Playwright skip %s', (source) => {
    expect(ciSkipCount('packages/app/tests/stress/a.e2e.ts', source)).toBe(1);
  });

  test.each([
    "test.skip(!SMOKE_ENABLED, 'x');",
    "test.skip(!DARWIN, 'x');",
    'test.skip(!BUILD_EXISTS, `x`);',
    "test.skip('cold-start deferred', () => {});",
    'test.skip();',
    "test.skip(decisionMade, 'x');",
    "test.skip(CIRCLE_FLAG, 'x');",
    'test.skip(true, "x");',
    "test.skip(config.CI, 'x');",
  ])('does not count %s as CI-keyed', (source) => {
    expect(ciSkipCount('packages/app/tests/stress/a.e2e.ts', source)).toBe(0);
  });

  test('counts each site', () => {
    expect(
      ciSkipCount(
        'packages/app/tests/stress/a.e2e.ts',
        "test.skip(IS_CI, 'a');\ntest.skip(process.env.CI, 'b');",
      ),
    ).toBe(2);
  });

  test.each([
    [
      "import { describe as _d } from 'vitest';\nconst describe = process.env.CI ? _d.skip : _d;",
      'file',
    ],
    ["(process.env.CI ? describe.skip : describe)('x', () => {});", 'describe'],
    ["describe.skipIf(process.env.CI)('x', () => {});", 'describe'],
    ["test.skipIf(process.env.CI ? a : b)('x', () => {});", 'test'],
    ["test('x', (ctx) => { ctx.skip(process.env.CI === 'true', 'no keyring on CI'); });", 'test'],
    ["test('x', ({ skip }) => { skip(process.env.GITHUB_ACTIONS !== undefined); });", 'test'],
    ["const ON_CI = Boolean(process.env.CI);\ntest.skipIf(ON_CI)('x', () => {});", 'test'],
    ["test('x', { skip: process.env.CI === 'true' }, () => {});", 'test'],
    ["test('x', (ctx) => { if (process.env.CI) { ctx.skip(); } });", 'test'],
    ["test.runIf(process.env.CI && FEATURE_FLAG)('x', () => {});", 'test'],
    ["test.skipIf(!process.env.CI || FLAG)('x', () => {});", 'test'],
    ["test.skipIf(process.env.CI || FLAG)('x', () => {});", 'test'],
    ["test.skipIf(process.env.CI && FLAG)('x', () => {});", 'test'],
    ["const RUN = process.env.CI && FEATURE_FLAG;\ntest.runIf(RUN)('x', () => {});", 'test'],
    ["const SKIP = !process.env.CI || FLAG;\ntest.skipIf(SKIP)('x', () => {});", 'test'],
    [
      "const TIMEOUT = process.env.CI ? 60_000 : 5_000;\ntest.skipIf(TIMEOUT > 10_000)('x', () => {});",
      'test',
    ],
  ])('finds the Vitest skip in %s', (source, scope) => {
    const gates = scanSource('packages/server/src/a.test.ts', source).gates;
    expect(gates.filter((gate) => gate.ci === 'skips-on-ci').map((gate) => gate.scope)).toEqual([
      scope,
    ]);
  });

  test.each([
    "test.runIf(process.env.CI)('x', () => {});",
    "test.skipIf(!process.env.CI)('x', () => {});",
    "test.skipIf(process.env.CI !== 'true')('x', () => {});",
    "describe.skipIf(process.env.CI === undefined)('x', () => {});",
    "test.runIf(process.env.CI || FLAG)('x', () => {});",
    "test.skipIf(!process.env.CI && FLAG)('x', () => {});",
  ])('lists %s as running only on CI, not as a CI skip', (source) => {
    const gates = scanSource('packages/server/src/a.test.ts', source).gates;
    expect(gates.map((gate) => gate.ci)).toEqual(['runs-only-on-ci']);
  });

  test.each([
    "test.skipIf(process.env.CIRCLE)('x', () => {});",
    "test.skipIf({ CI: true }.CI_FLAG)('x', () => {});",
    "test.skipIf(process.platform === 'win32')('x', () => {});",
  ])('lists %s as an environment gate', (source) => {
    const gates = scanSource('packages/server/src/a.test.ts', source).gates;
    expect(gates.map((gate) => gate.ci)).toEqual([null]);
  });
});

describe('known-reds scanner: early returns and not-run tests', () => {
  test.each([
    "test('x', () => { if (process.platform === 'win32') return; expect(1).toBe(1); });",
    "const IS_WIN = process.platform === 'win32';\ntest('x', () => { if (IS_WIN) { console.log('skip'); return; } expect(1).toBe(1); });",
    "import { existsSync } from 'node:fs';\ntest('x', () => { if (!existsSync(built)) return; expect(1).toBe(1); });",
    "import os from 'node:os';\ntest('x', () => { if (os.platform() !== 'darwin') return; expect(1).toBe(1); });",
    "test('x', () => { if (process.env.OK_AUDIT === '1') { report(); return; } expect(1).toBe(1); });",
    "describe('x', () => { const isWin = process.platform === 'win32'; test('y', () => { if (isWin) return; expect(1).toBe(1); }); });",
  ])('flags the environment early return in %s', (source) => {
    expect(scanSource('packages/server/src/a.test.ts', source).earlyReturns).toHaveLength(1);
  });

  test.each([
    "test('x', () => { const button = find(); if (!button) return; expect(button).toBeTruthy(); });",
    "test('x', () => { expect(a).toBe(1); if (process.platform === 'win32') return; expect(b).toBe(2); });",
    "test('x', async () => { await vi.waitFor(() => expect(a).toBe(1)); if (process.platform === 'win32') return; });",
    "test('x', () => { const f = () => { if (process.platform === 'win32') return; }; f(); expect(1).toBe(1); });",
    "test('x', () => { if (process.platform === 'win32') return promise; expect(1).toBe(1); });",
    "test('x', (ctx) => { if (process.platform === 'win32') { ctx.skip(); return; } expect(1).toBe(1); });",
    "describe('x', () => { if (process.platform === 'win32') return; test('y', () => { expect(1).toBe(1); }); });",
  ])('leaves %s alone', (source) => {
    expect(scanSource('packages/server/src/a.test.ts', source).earlyReturns).toEqual([]);
  });

  test('flags a Playwright early return too', () => {
    const source = "test('x', async () => { if (process.platform === 'win32') return; });";
    expect(scanSource('packages/app/tests/stress/a.e2e.ts', source).earlyReturns).toHaveLength(1);
  });

  test('reads the test context from test.for, and none from test.each', () => {
    const forSource =
      "test.for(cases)('x $name', (row, ctx) => { ctx.skip(process.platform === 'win32', 'posix'); expect(row).toBeTruthy(); });";
    expect(
      scanSource('packages/server/src/a.test.ts', forSource).gates.map((gate) => gate.form),
    ).toEqual(['context-skip']);
    const eachSource =
      "test.each(cases)('x $name', (row) => { row.skip(process.platform === 'win32'); expect(row).toBeTruthy(); });";
    expect(scanSource('packages/server/src/a.test.ts', eachSource).gates).toEqual([]);
  });

  test('lists unconditional skips, fixme and todo as not run', () => {
    const vitest = scanSource(
      'packages/server/src/a.test.ts',
      "test.skip('a', () => {});\ntest.todo('b');\ntest('c', { skip: true }, () => {});\ntest('d', (ctx) => { ctx.skip('not yet'); });",
    );
    expect(vitest.notRun.map((row) => row.form)).toEqual([
      'skip',
      'todo',
      'skip-option',
      'context-skip',
    ]);
    const playwright = scanSource(
      'packages/app/tests/stress/a.e2e.ts',
      "test('e', async () => { test.skip(true, 'PR #1010 broke it'); });\ntest.fixme('f', async () => {});",
    );
    expect(playwright.notRun.map((row) => [row.form, row.scope])).toEqual([
      ['skip', 'test'],
      ['fixme', 'test'],
    ]);
  });

  test('takes a literal-true skip’s condition from the if around it', () => {
    const source =
      "async function settle() { if (workArea.width < width) { test.skip(true, 'too small'); } }";
    const scan = scanSource('packages/desktop/tests/smoke/a.e2e.ts', source);
    expect(scan.notRun).toEqual([]);
    expect(scan.gates.map((gate) => [gate.scope, gate.condition, gate.reason])).toEqual([
      ['helper', 'workArea.width < width', 'too small'],
    ]);
  });

  test('ignores runner-like calls on other objects', () => {
    const scan = scanSource(
      'packages/server/src/a.test.ts',
      "test('x', () => { harness.test.skip(process.env.CI); runner.skipIf(process.env.CI); });",
    );
    expect(scan.gates).toEqual([]);
    expect(scan.problems).toEqual([]);
  });
});

describe('known-reds validation', () => {
  const pinReport = (fields) => ({
    problems: [],
    pins: [
      {
        path: 'a.test.ts',
        line: 1,
        runner: 'vitest',
        title: 't',
        issue: ISSUE,
        owner: 'get-main-green',
        until: '2026-10-15',
        ...fields,
      },
    ],
    quarantines: [],
    earlyReturns: [],
    ciSkips: [],
  });
  const messages = (report, allowlist = NO_ALLOWLIST) =>
    validate(report, { today: TODAY, allowlist }).map((violation) => violation.message);

  test('accepts a complete pin', () => {
    expect(messages(pinReport({}))).toEqual([]);
  });

  test.each([
    [{ owner: undefined }, 'known-bug pin has no owner'],
    [
      { owner: 'someone-else' },
      `known-bug pin has owner "someone-else", which is not one of ${OWNERS.join(', ')}`,
    ],
    [{ issue: undefined }, 'known-bug pin has no issue link'],
    [
      { issue: 'inkeep/agents-private#1056' },
      'known-bug pin has issue "inkeep/agents-private#1056", which is not a GitHub or Linear issue URL',
    ],
    [{ until: undefined }, 'known-bug pin has no until date'],
    [{ until: '15/10/2026' }, 'known-bug pin has until "15/10/2026", which is not YYYY-MM-DD'],
    [{ until: '2026-02-30' }, 'known-bug pin has until "2026-02-30", which is not a date'],
    [{ until: '2026-09-30' }, 'known-bug pin expired on 2026-09-30'],
    [
      { until: '2026-12-31' },
      `known-bug pin has until 2026-12-31, beyond the ${MAX_HORIZON_DAYS}-day horizon (2026-12-30)`,
    ],
  ])('refuses %j', (fields, message) => {
    expect(messages(pinReport(fields))).toEqual([message]);
  });

  test(`lists what expires within ${EXPIRY_WARNING_DAYS} days, without failing it`, () => {
    const report = {
      ...pinReport({}),
      pins: [
        { path: 'a.test.ts', line: 1, until: '2026-10-08', owner: 'get-main-green' },
        { path: 'b.test.ts', line: 2, until: '2026-10-15', owner: 'get-main-green' },
        { path: 'c.test.ts', line: 3, until: '2026-10-16', owner: 'get-main-green' },
      ],
    };
    const allowlist = {
      ciSkips: [{ path: 'd.test.ts', condition: 'CI', owner: 'known-reds', until: '2026-10-02' }],
    };
    expect(expiringSoon(report, { today: TODAY, allowlist })).toEqual([
      { kind: 'pin', path: 'a.test.ts', line: 1, owner: 'get-main-green', until: '2026-10-08' },
      { kind: 'pin', path: 'b.test.ts', line: 2, owner: 'get-main-green', until: '2026-10-15' },
      {
        kind: 'ci-skip-entry',
        path: 'd.test.ts',
        line: null,
        owner: 'known-reds',
        until: '2026-10-02',
      },
    ]);
  });

  test('the listing names each expiring kind', () => {
    const report = {
      files: 3,
      problems: [],
      pins: [{ path: 'a.test.ts', line: 1, until: '2026-10-08', owner: 'get-main-green' }],
      quarantines: [{ path: 'q.test.ts', line: 4, until: '2026-10-09', owner: 'get-main-green' }],
      earlyReturns: [],
      ciSkips: [],
      notRun: [],
      envGates: [],
    };
    const allowlist = {
      ciSkips: [{ path: 'd.test.ts', condition: 'CI', owner: 'known-reds', until: '2026-10-02' }],
    };
    const upcoming = expiringSoon(report, { today: TODAY, allowlist });
    expect(render(report, [], upcoming, TODAY, { all: false })).toContain(
      [
        `Expiring within ${EXPIRY_WARNING_DAYS} days (3)`,
        '  pin  a.test.ts:1  owner get-main-green, until 2026-10-08',
        '  quarantine  q.test.ts:4  owner get-main-green, until 2026-10-09',
        '  allowlisted CI skip  d.test.ts  owner known-reds, until 2026-10-02',
      ].join('\n'),
    );
  });

  test('the date boundaries are inclusive', () => {
    expect(messages(pinReport({ until: TODAY }))).toEqual([]);
    expect(messages(pinReport({ until: '2026-12-30' }))).toEqual([]);
  });

  test('accepts a Linear issue', () => {
    expect(
      messages(pinReport({ issue: 'https://linear.app/inkeep/issue/PRD-8603/symlink-reads' })),
    ).toEqual([]);
  });

  test('holds a quarantine to the same fields', () => {
    const report = {
      ...pinReport({}),
      pins: [],
      quarantines: [
        { path: 'a.test.ts', line: 1, title: 't', issue: ISSUE, owner: 'get-main-green' },
      ],
    };
    expect(messages(report)).toEqual(['quarantine has no until date']);
  });

  test('refuses an environment early return', () => {
    const report = {
      ...pinReport({}),
      pins: [],
      earlyReturns: [{ path: 'a.test.ts', line: 3, condition: "process.platform === 'win32'" }],
    };
    expect(
      validate(report, { today: TODAY, allowlist: NO_ALLOWLIST }).map(
        (violation) => violation.rule,
      ),
    ).toEqual(['early-return']);
  });

  describe('the CI-skip allowlist', () => {
    const skip = {
      path: 'packages/server/src/boot.test.ts',
      line: 3,
      form: 'alias',
      scope: 'file',
      condition: 'process.env.CI',
    };
    const entry = {
      path: skip.path,
      condition: skip.condition,
      owner: 'known-reds',
      until: '2026-11-01',
      reason: 'skips the whole file on CI',
    };
    const report = { ...pinReport({}), pins: [], ciSkips: [skip] };
    const ruleNames = (allowlist) =>
      validate(report, { today: TODAY, allowlist }).map((violation) => violation.rule);

    test('refuses a CI skip that is not listed', () => {
      expect(ruleNames(NO_ALLOWLIST)).toEqual(['ci-skip']);
    });

    test('accepts a listed, owned, dated CI skip', () => {
      expect(ruleNames({ ciSkips: [entry] })).toEqual([]);
    });

    test('permits exactly one site per entry', () => {
      const twice = { ...report, ciSkips: [skip, { ...skip, line: 40 }] };
      expect(
        validate(twice, { today: TODAY, allowlist: { ciSkips: [entry] } }).map(
          (violation) => `${violation.line} ${violation.rule}`,
        ),
      ).toEqual(['40 ci-skip']);
    });

    test('matches on the condition as well as the path', () => {
      expect(
        ruleNames({ ciSkips: [{ ...entry, condition: "process.env.CI === 'true'" }] }),
      ).toEqual(['ci-skip', 'allowlist-stale']);
    });

    test('refuses a stale, expired, unowned or unexplained entry', () => {
      expect(
        validate({ ...report, ciSkips: [] }, { today: TODAY, allowlist: { ciSkips: [entry] } }).map(
          (violation) => violation.rule,
        ),
      ).toEqual(['allowlist-stale']);
      expect(ruleNames({ ciSkips: [{ ...entry, until: '2026-09-01' }] })).toEqual([
        'allowlist-fields',
      ]);
      expect(ruleNames({ ciSkips: [{ ...entry, owner: 'nobody' }] })).toEqual(['allowlist-fields']);
      expect(ruleNames({ ciSkips: [{ ...entry, reason: '' }] })).toEqual(['allowlist-fields']);
    });
  });
});

describe('known-reds through its real invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-known-reds-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, source) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  write(
    'packages/server/src/planted-boot.test.ts',
    "import { describe as _d } from 'vitest';\nconst describe = process.env.CI ? _d.skip : _d;\ndescribe('boot', () => {});\n",
  );
  write(
    'packages/server/src/spawn.test.ts',
    "test('x', () => { if (process.platform === 'win32') return; expect(1).toBe(1); });\n",
  );
  write('packages/app/tests/stress/hide.e2e.ts', playwrightPin(''));
  write(
    'packages/app/src/helper.test-helper.ts',
    "test.skip(process.env.CI, 'not a test file');\n",
  );
  write('reports/spike/probe.test.ts', "test.skip(process.env.CI, 'evidence');\n");
  write('specs/spike/probe.e2e.ts', "test.skip(process.env.CI, 'evidence');\n");
  write('node_modules/pkg/dep.test.js', "test.skip(process.env.CI, 'vendored');\n");
  const init = spawnSync('git', ['init', '-q'], {
    cwd: root,
    env: gitCleanEnv(),
    windowsHide: true,
    encoding: 'utf8',
  });

  test('scans exactly the test files a runner could run', () => {
    expect(init.status).toBe(0);
    expect(listTestFiles(root)).toEqual([
      'packages/app/tests/stress/hide.e2e.ts',
      'packages/server/src/planted-boot.test.ts',
      'packages/server/src/spawn.test.ts',
    ]);
  });

  test('finds every planted violation', () => {
    const report = scanTree(root);
    const violations = validate(report, { today: TODAY, allowlist: NO_ALLOWLIST });
    expect(
      violations.map((violation) => `${violation.path}:${violation.line} ${violation.rule}`).sort(),
    ).toEqual([
      'packages/app/tests/stress/hide.e2e.ts:6 pin-retries',
      'packages/server/src/planted-boot.test.ts:2 ci-skip',
      'packages/server/src/spawn.test.ts:1 early-return',
    ]);
  });

  test('the command exits 1 on violations, and lists them in its JSON feed', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--json', '--root', root], {
      encoding: 'utf8',
      env: gitCleanEnv(),
      windowsHide: true,
    });
    expect(run.status).toBe(1);
    const feed = JSON.parse(run.stdout);
    expect(feed.schemaVersion).toBe(1);
    expect(feed.files).toBe(3);
    expect(feed.violations.map((violation) => violation.rule)).toEqual(
      expect.arrayContaining(['pin-retries', 'ci-skip', 'early-return']),
    );
  });

  test('the command warns about a pin that expires soon, in the feed and the listing', () => {
    const soon = new Date(Date.parse(`${todayUtc()}T00:00:00Z`) + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    write(
      'packages/server/src/expiring.test.ts',
      vitestPin({ meta: `{ issue: '${ISSUE}', owner: 'get-main-green', until: '${soon}' }` }),
    );
    try {
      const json = spawnSync(process.execPath, [SCRIPT, '--json', '--root', root], {
        encoding: 'utf8',
        env: gitCleanEnv(),
        windowsHide: true,
      });
      expect(JSON.parse(json.stdout).expiringSoon).toEqual(
        expect.arrayContaining([
          {
            kind: 'pin',
            path: 'packages/server/src/expiring.test.ts',
            line: 4,
            owner: 'get-main-green',
            until: soon,
          },
        ]),
      );
      const listing = spawnSync(process.execPath, [SCRIPT, '--root', root], {
        encoding: 'utf8',
        env: gitCleanEnv(),
        windowsHide: true,
      });
      expect(listing.stdout).toMatch(
        new RegExp(`Expiring within ${EXPIRY_WARNING_DAYS} days \\(\\d+\\)`),
      );
      expect(listing.stdout).toContain(
        `pin  packages/server/src/expiring.test.ts:4  owner get-main-green, until ${soon}`,
      );
    } finally {
      rmSync(join(root, 'packages/server/src/expiring.test.ts'), { force: true });
    }
  });

  test('the listing names the planted sites and points at the convention', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--root', root], {
      encoding: 'utf8',
      env: gitCleanEnv(),
      windowsHide: true,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('Known reds in open-knowledge on ');
    expect(run.stdout).toContain(': 3 test files scanned.');
    expect(run.stdout).toContain(
      'packages/server/src/planted-boot.test.ts:2  file  process.env.CI',
    );
    expect(run.stdout).toContain(`The convention: ${CONVENTION_DOC}.`);
  });

  test('the command exits 2, not 0, when it cannot scan', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'ok-known-reds-bare-'));
    try {
      const run = spawnSync(process.execPath, [SCRIPT, '--root', notARepo], {
        encoding: 'utf8',
        env: { ...gitCleanEnv(), GIT_CEILING_DIRECTORIES: tmpdir() },
        windowsHide: true,
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/^known-reds: could not run: /);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('known-reds on this tree', () => {
  const files = listTestFiles(OK_ROOT);

  test('scans every runner’s test files and nothing under reports/ or specs/', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'scripts/check-known-reds.uncached.test.mjs',
        'test-support/known-bug.test.ts',
        'packages/app/tests/stress/file-tree-create.e2e.ts',
        'packages/desktop/tests/smoke/mcp-wiring.e2e.ts',
      ]),
    );
    expect(
      files.filter((path) => path.startsWith('reports/') || path.startsWith('specs/')),
    ).toEqual([]);
  });

  test('conforms: pins, quarantines, CI skips and early returns follow the convention', () => {
    const violations = validate(scanTree(OK_ROOT), {
      today: todayUtc(),
      allowlist: loadAllowlist(),
    });
    expect(
      violations.map(
        (violation) =>
          `${violation.path}:${violation.line} [${violation.rule}] ${violation.message}`,
      ),
    ).toEqual([]);
  });

  test('the allowlist is the file the command reads', () => {
    expect(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))).toEqual(loadAllowlist());
  });

  test('every Vitest tier declares the known-bug and quarantine tags', () => {
    expect(okVitestBase.test.tags.map((tag) => tag.name)).toEqual([KNOWN_BUG_TAG, QUARANTINE_TAG]);
  });

  test('the convention doc and the guard cite each other', () => {
    const doc = readFileSync(join(OK_ROOT, CONVENTION_DOC), 'utf8');
    for (const cited of [
      'scripts/check-known-reds.uncached.test.mjs',
      'scripts/known-reds.mjs',
      'scripts/known-reds-allowlist.json',
      'pnpm known-reds',
      `no more than ${MAX_HORIZON_DAYS} days away`,
      `at least ${MIN_SIGNATURE_LITERAL} literal characters in a row`,
      `Expiring within ${EXPIRY_WARNING_DAYS} days`,
    ]) {
      expect(doc, `${CONVENTION_DOC} must mention ${cited}`).toContain(cited);
    }
  });

  test('pnpm known-reds runs this command', () => {
    const manifest = JSON.parse(readFileSync(join(OK_ROOT, 'package.json'), 'utf8'));
    expect(manifest.scripts['known-reds']).toBe('node scripts/known-reds.mjs');
  });
});
