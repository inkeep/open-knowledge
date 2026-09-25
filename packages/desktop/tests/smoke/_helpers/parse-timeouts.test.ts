import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS, PACKAGED_APP_ENV } from './launch-desktop';
import { BOOT_LOG_POLL_MS, readinessGiveUpBoundMs } from './launch-readiness';
import {
  type ChargeTier,
  extractHelperBudgets,
  extractReadinessBudgets,
  extractTestEntries,
  type FileAnalysis,
  parseNumericLiteral,
  parsePlaywrightConfigTimeout,
  parseTestFile,
  perTestBudgetMs,
  stripCommentsAndStrings,
  sumOfDeclaredBoundsMs,
  type TestEntry,
} from './parse-timeouts';
import {
  giveUpOf,
  LAUNCH_REACHING_THE_CEILING_OF,
  pollIntervalOf,
  READINESS_CALLS,
  READINESS_PATHS,
  type ReadinessCallOptions,
  reachOf,
  SCRIPTED_LAUNCHES,
  type ScriptedLaunch,
} from './readiness-reach.test-helper';

function onlyCharge(chargesMs: readonly number[]): number {
  expect(chargesMs).toHaveLength(1);
  return chargesMs[0] ?? Number.NaN;
}

async function helperGiveUpMs(launch: ScriptedLaunch, chargedMs: number): Promise<number> {
  const reach = await reachOf(launch, 2 * chargedMs);
  expect(
    reach,
    `the readiness wait on ${launch.name}, watched for twice the ${chargedMs}ms charged`,
  ).toMatchObject({ gaveUpAtMs: expect.any(Number) });
  return 'gaveUpAtMs' in reach ? reach.gaveUpAtMs : Number.NaN;
}

function pinChargeToWhatTheHelperWaits(
  options: ReadinessCallOptions,
  chargedMs: () => number,
): void {
  for (const launch of SCRIPTED_LAUNCHES.map((script) => script(options))) {
    test(`the helper gives up no later than the charge on ${launch.name}`, async () => {
      const charge = chargedMs();
      expect(await helperGiveUpMs(launch, charge), launch.name).toBeLessThanOrEqual(charge);
    });
  }

  test('the charge covers the latest the helper waits, by at most one poll interval', async () => {
    const charge = chargedMs();
    const giveUpsMs: number[] = [];
    for (const script of SCRIPTED_LAUNCHES) {
      giveUpsMs.push(await helperGiveUpMs(script(options), charge));
    }
    const overchargeMs = charge - Math.max(...giveUpsMs);
    expect(overchargeMs).toBeGreaterThanOrEqual(0);
    expect(overchargeMs).toBeLessThanOrEqual(pollIntervalOf(options));
  });
}

type DeclaredTest = Parameters<typeof sumOfDeclaredBoundsMs>[0];

type PerTestScoring = Parameters<typeof perTestBudgetMs>[1];

const STEP_TIMEOUT_MS = 15_000;

const CONFIG_CI_OUTER_MS = 150_000;

const SMOKE_SPEC_DIR = join(__dirname, '..');

const CONSENT_DIALOG_SPEC = join(SMOKE_SPEC_DIR, 'consent-dialog.e2e.ts');

const DESKTOP_PLAYWRIGHT_CONFIG = join(SMOKE_SPEC_DIR, '..', '..', 'playwright.config.ts');

const fixtureRoot = mkdtempSync(join(tmpdir(), 'parse-timeouts-fixture-'));

let fixtureCount = 0;

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFixture(suffix: string, lines: readonly string[]): string {
  fixtureCount += 1;
  const file = join(fixtureRoot, `fixture-${fixtureCount}${suffix}`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function lineHolding(lines: readonly string[], fragment: string): number {
  const index = lines.findIndex((line) => line.includes(fragment));
  if (index === -1) throw new Error(`the fixture has no line holding ${fragment}`);
  return index + 1;
}

function entryDeclaredAt(analysis: FileAnalysis, line: number): TestEntry {
  const entry = analysis.tests.find((candidate) => candidate.lineNumber === line);
  assert.isDefined(entry, `a test is declared at ${analysis.filePath}:${line}`);
  return entry;
}

describe('parseNumericLiteral', () => {
  test('plain digits', () => {
    expect(parseNumericLiteral('60000')).toBe(60000);
  });
  test('underscore separators', () => {
    expect(parseNumericLiteral('60_000')).toBe(60000);
    expect(parseNumericLiteral('120_000')).toBe(120000);
    expect(parseNumericLiteral('1_000_000')).toBe(1000000);
  });
});

describe('stripCommentsAndStrings', () => {
  test('strips line comments and preserves the trailing newline', () => {
    const src = '// hi\nfoo';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe('     \nfoo');
  });

  test('strips block comments and preserves length', () => {
    const src = '/* hi */ foo';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe('         foo');
  });

  test('strips single-quote string contents but keeps quotes', () => {
    const src = "'hello' foo";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe("'     ' foo");
  });

  test('strips double-quote string contents but keeps quotes', () => {
    const src = '"hello" foo';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe('"     " foo');
  });

  test('strips backtick string contents but keeps backticks', () => {
    const src = '`hello` foo';
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe('`     ` foo');
  });

  test('preserves length for varied mixed input', () => {
    const src = `function f() {
  const a = 'foo'; // a comment
  /* block */
  return \`tpl-\${a}\`;
}`;
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  test('handles escaped quotes inside single-quote strings', () => {
    const src = "'don\\'t'";
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe("'      '");
  });
});

describe('extractHelperBudgets', () => {
  test('captures default-parameter timeoutMs', () => {
    const src = `
async function findWindowByMode(app: ElectronApplication, mode: string, timeoutMs = 20_000): Promise<Page> {
  await expect.poll(async () => true, { timeout: timeoutMs });
  return null as any;
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([{ name: 'findWindowByMode', maxTimeoutMs: 20000 }]);
  });

  test('captures body-literal timeout', () => {
    const src = `
async function launchApp(home: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY],
    timeout: 30_000,
    env: { HOME: home },
  });
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([{ name: 'launchApp', maxTimeoutMs: 30000 }]);
  });

  test('uses max(default-param, body) when both present', () => {
    const src = `
async function mixed(timeoutMs = 10_000) {
  await something({ timeout: 25_000 });
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([{ name: 'mixed', maxTimeoutMs: 25000 }]);
  });

  test('excludes helpers with no timeout-bounded operations', () => {
    const src = `
function seedTmpHome(prefix: string): string {
  return '/tmp/' + prefix;
}
function trackForCleanup(...paths: string[]): void {
  cleanupTargets.push(...paths);
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([]);
  });

  test('excludes test() and describe() shadowing', () => {
    const src = `
function test(name: string) { /* timeout: 99_000 */ }
function describe(name: string) { /* timeout: 99_000 */ }
function helper(timeoutMs = 5_000) { return 1; }
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([{ name: 'helper', maxTimeoutMs: 5000 }]);
  });

  test('helper with multiple timeout literals reports MAX, not SUM', () => {
    const src = `
async function multiWait() {
  await first({ timeout: 15_000 });
  await second({ timeout: 10_000 });
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([{ name: 'multiWait', maxTimeoutMs: 15000 }]);
  });

  test('does not detect helpers with caller-supplied timeout (no default)', () => {
    const src = `
async function waitForX(app: any, timeoutMs: number) {
  await expect.poll(fn, { timeout: timeoutMs });
}
`;
    const helpers = extractHelperBudgets(src);
    expect(helpers).toEqual([]);
  });
});

describe('extractTestEntries', () => {
  test('extracts direct timeout literals from test body', () => {
    const src = `
test.describe('suite', () => {
  test('a test', async ({ x }) => {
    await expect(loc).toBeVisible({ timeout: 15_000 });
    await expect.poll(fn, { timeout: 30_000 });
  });
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries).toHaveLength(1);
    expect(entries[0].testName).toBe('a test');
    expect(entries[0].directTimeoutsMs).toEqual([15000, 30000]);
    expect(entries[0].cumulativeMs).toBe(45000);
  });

  test('extracts toPass budgets distinctly', () => {
    const src = `
test('toPass test', async () => {
  await expect(async () => {}).toPass({ timeout: 5_000 });
  await expect(async () => {}).toPass({ timeout: 15_000 });
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries).toHaveLength(1);
    expect(entries[0].toPassBudgetsMs).toEqual([5000, 15000]);
    expect(entries[0].directTimeoutsMs).toEqual([5000, 15000]);
  });

  test('traces same-file helper calls and adds their max budget', () => {
    const src = `
async function launchApp(home: string) {
  return electron.launch({ timeout: 30_000 });
}
async function findWindowByMode(app: any, mode: string, timeoutMs = 20_000) {
  await expect.poll(fn, { timeout: timeoutMs });
}
test('a test', async () => {
  const app = await launchApp(tmpHome);
  const win = await findWindowByMode(app, 'navigator');
  await expect(loc).toBeVisible({ timeout: 15_000 });
});
`;
    const helpers = extractHelperBudgets(src);
    const entries = extractTestEntries(src, helpers);
    expect(entries).toHaveLength(1);
    expect(entries[0].helperCallNames).toEqual(['launchApp', 'findWindowByMode']);
    expect(entries[0].tracedHelperBudgetsMs).toEqual([30000, 20000]);
    expect(entries[0].directTimeoutsMs).toEqual([15000]);
    expect(entries[0].cumulativeMs).toBe(65000);
  });

  test('finds multiple test() entries in a single file', () => {
    const src = `
test('first', async () => {
  await expect(loc).toBeVisible({ timeout: 10_000 });
});
test('second', async () => {
  await expect(loc).toBeVisible({ timeout: 20_000 });
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries).toHaveLength(2);
    expect(entries[0].testName).toBe('first');
    expect(entries[1].testName).toBe('second');
  });

  test('multiple helper calls of the same name sum their contributions', () => {
    const src = `
async function helper(timeoutMs = 10_000) {}
test('multi-call', async () => {
  await helper();
  await helper();
  await helper();
});
`;
    const helpers = extractHelperBudgets(src);
    const entries = extractTestEntries(src, helpers);
    expect(entries[0].tracedHelperBudgetsMs).toEqual([10000, 10000, 10000]);
    expect(entries[0].cumulativeMs).toBe(30000);
  });

  test('does not detect helper calls inside comments', () => {
    const src = `
async function launchApp() {
  return electron.launch({ timeout: 30_000 });
}
test('a test', async () => {
  // launchApp();  // commented out
  await something();
});
`;
    const helpers = extractHelperBudgets(src);
    const entries = extractTestEntries(src, helpers);
    expect(entries[0].helperCallNames).toEqual([]);
    expect(entries[0].cumulativeMs).toBe(0);
  });

  test('does not detect helper names inside string literals', () => {
    const src = `
async function launchApp() {
  return electron.launch({ timeout: 30_000 });
}
test('error path', async () => {
  throw new Error('launchApp(args) failed');
});
`;
    const helpers = extractHelperBudgets(src);
    const entries = extractTestEntries(src, helpers);
    expect(entries[0].helperCallNames).toEqual([]);
  });

  test('extracts test.setTimeout(N) as perTestTimeoutMs', () => {
    const src = `
test('heavy test', async () => {
  test.setTimeout(240_000);
  await something({ timeout: 30_000 });
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries[0].perTestTimeoutMs).toBe(240_000);
  });

  test('perTestTimeoutMs is null when no test.setTimeout call exists', () => {
    const src = `
test('plain test', async () => {
  await something({ timeout: 15_000 });
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries[0].perTestTimeoutMs).toBeNull();
  });

  test('multiple test.setTimeout calls — takes the maximum', () => {
    const src = `
test('conditional', async () => {
  if (process.env.CI) {
    test.setTimeout(240_000);
  } else {
    test.setTimeout(120_000);
  }
  await something();
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries[0].perTestTimeoutMs).toBe(240_000);
  });

  test('ignores test.setTimeout inside comments and strings', () => {
    const src = `
test('clean', async () => {
  // test.setTimeout(999_000);
  const note = 'test.setTimeout(888_000) is what we used to do';
  await something();
});
`;
    const entries = extractTestEntries(src, []);
    expect(entries[0].perTestTimeoutMs).toBeNull();
  });
});

describe('parsePlaywrightConfigTimeout', () => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'parse-timeouts-test-'));
  const cleanup: string[] = [];

  function writeConfig(contents: string): string {
    const p = join(tmpdirRoot, `cfg-${cleanup.length}.ts`);
    writeFileSync(p, contents);
    cleanup.push(p);
    return p;
  }

  beforeAll(() => {});

  afterAll(() => {
    try {
      rmSync(tmpdirRoot, { recursive: true, force: true });
    } catch {}
  });

  test('literal numeric timeout', () => {
    const p = writeConfig(`
import { defineConfig } from '@playwright/test';
export default defineConfig({
  timeout: 60_000,
  retries: 2,
});
`);
    const t = parsePlaywrightConfigTimeout(p);
    expect(t.ci).toBe(60000);
    expect(t.local).toBe(60000);
    expect(t.raw).toBe('60_000');
  });

  test('process.env.CI ternary timeout', () => {
    const p = writeConfig(`
import { defineConfig } from '@playwright/test';
export default defineConfig({
  timeout: process.env.CI ? 120_000 : 60_000,
  retries: process.env.CI ? 2 : 0,
});
`);
    const t = parsePlaywrightConfigTimeout(p);
    expect(t.ci).toBe(120000);
    expect(t.local).toBe(60000);
    expect(t.raw).toBe('process.env.CI ? 120_000 : 60_000');
  });

  test('throws on unsupported shape', () => {
    const p = writeConfig(`
import { defineConfig } from '@playwright/test';
const T = 60_000;
export default defineConfig({
  timeout: T,
});
`);
    expect(() => parsePlaywrightConfigTimeout(p)).toThrow(/unsupported.*timeout.*shape/i);
  });

  test('throws when no timeout key', () => {
    const p = writeConfig(`
import { defineConfig } from '@playwright/test';
export default defineConfig({
  retries: 0,
});
`);
    expect(() => parsePlaywrightConfigTimeout(p)).toThrow(/No top-level/);
  });

  test('ignores commented timeout reference before defineConfig', () => {
    const p = writeConfig(`
import { defineConfig } from '@playwright/test';
// e.g. timeout: 30_000, before bump
export default defineConfig({
  timeout: 120_000,
});
`);
    const t = parsePlaywrightConfigTimeout(p);
    expect(t.ci).toBe(120000);
    expect(t.local).toBe(120000);
  });
});

describe('parseTestFile (real file, sanity)', () => {
  const consentDialog = join(__dirname, '..', 'consent-dialog.e2e.ts');

  test('consent-dialog.e2e.ts yields helpers + tests', () => {
    const fa = parseTestFile(consentDialog);
    expect(fa.helpers.length).toBeGreaterThan(0);
    expect(fa.tests.length).toBeGreaterThanOrEqual(3);
    const byName = new Map(fa.helpers.map((h) => [h.name, h.maxTimeoutMs]));
    expect(byName.get('launchApp') ?? 0).toBeGreaterThan(0);
    expect(byName.get('expandAdvancedSettings') ?? 0).toBeGreaterThan(0);
    expect(byName.has('findWindowByMode')).toBe(true);
  });

  describe('consent-dialog.e2e.ts findWindowByMode, which wraps a plain waitForWindowByMode call', () => {
    pinChargeToWhatTheHelperWaits({}, () =>
      onlyCharge(
        parseTestFile(consentDialog)
          .helpers.filter((helper) => helper.name === 'findWindowByMode')
          .map((helper) => helper.maxTimeoutMs),
      ),
    );
  });
});

describe('readiness-helper attribution', () => {
  for (const { label, source, options } of READINESS_CALLS) {
    describe(label, () => {
      pinChargeToWhatTheHelperWaits(options, () => onlyCharge(extractReadinessBudgets(source)));
    });
  }

  describe('a waitForWindowByMode called straight from a test body', () => {
    const src = `test('x', async () => {\n  await waitForWindowByMode(app, 'editor');\n});\n`;

    test('is counted once, and that one charge is the whole of the test cumulative', () => {
      const entry = extractTestEntries(src, [])[0];
      expect(entry?.directTimeoutsMs).toHaveLength(1);
      expect(entry?.cumulativeMs).toBe(entry?.directTimeoutsMs[0]);
    });

    pinChargeToWhatTheHelperWaits({}, () =>
      onlyCharge(extractTestEntries(src, [])[0]?.directTimeoutsMs ?? []),
    );
  });
});

describe('the charge on each path is the deadline the helper arms there, plus one poll', () => {
  for (const { label, source, options } of READINESS_CALLS) {
    describe(label, () => {
      for (const path of READINESS_PATHS) {
        test(`on the ${path} path, one poll short of the charge is the deadline the helper armed`, async () => {
          const charge = onlyCharge(extractReadinessBudgets(source, { path }));
          const launch = LAUNCH_REACHING_THE_CEILING_OF[path](options);
          const giveUp = giveUpOf(await reachOf(launch, 2 * charge), launch);
          expect(giveUp.decidingCapMs, launch.name).toBe(charge - pollIntervalOf(options));
        });
      }

      test('on the packaged path, the charge covers the stage-only give-up by at most one poll, and is the packaged give-up bound', async () => {
        const charge = onlyCharge(extractReadinessBudgets(source, { path: 'packaged' }));
        const overchargeMs =
          charge - (await helperGiveUpMs(LAUNCH_REACHING_THE_CEILING_OF.packaged(options), charge));
        expect(overchargeMs).toBeGreaterThanOrEqual(0);
        expect(overchargeMs).toBeLessThanOrEqual(pollIntervalOf(options));
        expect(charge).toBe(readinessGiveUpBoundMs({ path: 'packaged', ...options }));
      });

      test("a charge that names no path is the fork path's give-up bound", () => {
        expect(onlyCharge(extractReadinessBudgets(source))).toBe(
          readinessGiveUpBoundMs({ path: 'fork', ...options }),
        );
      });
    });
  }

  describe('consent-dialog.e2e.ts findWindowByMode', () => {
    const findWindowByModeCharge = (tier?: ChargeTier): number =>
      onlyCharge(
        parseTestFile(CONSENT_DIALOG_SPEC, tier)
          .helpers.filter((helper) => helper.name === 'findWindowByMode')
          .map((helper) => helper.maxTimeoutMs),
      );

    test('on the packaged path, covers the stage-only give-up by at most one poll, and is the packaged give-up bound', async () => {
      const charge = findWindowByModeCharge({ path: 'packaged' });
      const overchargeMs =
        charge - (await helperGiveUpMs(LAUNCH_REACHING_THE_CEILING_OF.packaged({}), charge));
      expect(overchargeMs).toBeGreaterThanOrEqual(0);
      expect(overchargeMs).toBeLessThanOrEqual(pollIntervalOf({}));
      expect(charge).toBe(readinessGiveUpBoundMs({ path: 'packaged' }));
    });

    test("with no path named, is the fork path's give-up bound", () => {
      expect(findWindowByModeCharge()).toBe(readinessGiveUpBoundMs({ path: 'fork' }));
    });
  });
});

describe("a call that names its own pollMs is charged the deadline the helper arms plus one of the call's own polls", () => {
  const options: ReadinessCallOptions = { pollMs: 2 * BOOT_LOG_POLL_MS };
  const source = `waitForWindowByMode(app, 'editor', { pollMs: ${2 * BOOT_LOG_POLL_MS} })`;

  for (const path of READINESS_PATHS) {
    test(`on the ${path} path, one of the call's own polls short of the charge is the deadline the helper armed, and the helper gives up before the charge`, async () => {
      const charge = onlyCharge(extractReadinessBudgets(source, { path }));
      const launch = LAUNCH_REACHING_THE_CEILING_OF[path](options);
      const giveUp = giveUpOf(await reachOf(launch, 2 * charge), launch);
      expect(giveUp.decidingCapMs, launch.name).toBe(charge - pollIntervalOf(options));
      expect(giveUp.gaveUpAtMs).toBeLessThan(charge);
    });
  }
});

describe('an options argument the charge cannot read is refused, never defaulted', () => {
  for (const unreadable of ['{ capMs: CAP }', '{ ...opts }', 'opts', '{ capMs }']) {
    test(`throws on ${unreadable}, naming it`, () => {
      expect(() =>
        extractReadinessBudgets(`waitForWindowByMode(app, 'editor', ${unreadable})`),
      ).toThrow(unreadable);
    });
  }

  for (const readable of ['{ home: homedir() }', "{ liveness: 'none' }"]) {
    test(`charges ${readable} the plain call's fork give-up bound`, () => {
      expect(extractReadinessBudgets(`waitForWindowByMode(app, 'editor', ${readable})`)).toEqual([
        readinessGiveUpBoundMs({ path: 'fork' }),
      ]);
    });
  }

  test("charges a liveness choice inside a helper, whose string the parser has blanked, the plain call's fork give-up bound", () => {
    const src = [
      'async function findTerminalWindow(app: ElectronApplication): Promise<Page> {',
      "  return waitForWindowByMode(app, 'terminal', { liveness: 'none' });",
      '}',
    ].join('\n');
    expect(extractHelperBudgets(src)).toEqual([
      { name: 'findTerminalWindow', maxTimeoutMs: readinessGiveUpBoundMs({ path: 'fork' }) },
    ]);
  });
});

describe('a stallMs or pollMs the charge cannot read is refused as well, never defaulted', () => {
  for (const unreadable of [
    '{ stallMs: STALL }',
    '{ pollMs: POLL }',
    '{ stallMs }',
    '{ pollMs }',
  ]) {
    test(`throws on ${unreadable}, naming it`, () => {
      expect(() =>
        extractReadinessBudgets(`waitForWindowByMode(app, 'editor', ${unreadable})`),
      ).toThrow(unreadable);
    });
  }
});

describe('a test title holding another quote kind is audited once, and whole', () => {
  const TITLES = [
    {
      holding: 'an embedded backtick',
      header: 'test("runs `ok start` against a fresh home", async () => {',
      endsWith: /against a fresh home$/,
    },
    {
      holding: 'a conditional between single quotes',
      header: `test(\`renders the \${success ? 'success' : 'failure'} result\`, async () => {`,
      endsWith: /'failure'\} result$/,
    },
    {
      holding: 'an escaped quote of its own kind',
      header: "test('keeps the app\\'s own verdict', async () => {",
      endsWith: /s own verdict$/,
    },
    {
      holding: 'an escaped quote of its own kind against its closing quote',
      header: "test('quotes \\'ok\\'', async () => {",
      endsWith: /ok\\?'$/,
    },
  ];

  for (const { holding, header, endsWith } of TITLES) {
    test(`a title holding ${holding}`, () => {
      const entries = extractTestEntries(
        [header, `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`, '});'].join(
          '\n',
        ),
        [],
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.cumulativeMs).toBe(STEP_TIMEOUT_MS);
      expect(entries[0]?.testName).toMatch(endsWith);
    });
  }

  test('every smoke test whose title holds another quote kind is audited', () => {
    const quoteTitled: DeclaredTest[] = [];
    for (const name of readdirSync(SMOKE_SPEC_DIR).filter((file) => file.endsWith('.e2e.ts'))) {
      const file = join(SMOKE_SPEC_DIR, name);
      const src = readFileSync(file, 'utf8');
      const stripped = stripCommentsAndStrings(src);
      for (const header of stripped.matchAll(/(?:^|\n)\s*test\(\s*(['"`])/g)) {
        const declaredAt = (header.index ?? 0) + header[0].indexOf('test(');
        const opensAt = (header.index ?? 0) + header[0].length - 1;
        const title = src.slice(opensAt + 1, stripped.indexOf(header[1] ?? '', opensAt + 1));
        if (/['"`]/.test(title)) {
          quoteTitled.push({ file, line: src.slice(0, declaredAt).split('\n').length });
        }
      }
    }
    expect(quoteTitled.length).toBeGreaterThan(0);
    const unaudited = quoteTitled.filter(
      ({ file, line }) => !parseTestFile(file).tests.some((entry) => entry.lineNumber === line),
    );
    expect(unaudited).toEqual([]);
  });
});

describe('a per-test outer is read in full: a number, the derived sum, or a refusal', () => {
  const derivedOuterTest = [
    "test('launches and finds the editor', async () => {",
    '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
    "  await waitForWindowByMode(app, 'editor');",
    `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
    '});',
  ];

  for (const path of READINESS_PATHS) {
    test(`reads sumOfDeclaredBoundsMs(test.info()) as the test's own sum on the ${path} path`, () => {
      const [entry] = extractTestEntries(derivedOuterTest.join('\n'), [], { path });
      expect(entry?.perTestTimeoutMs).toBe(entry?.cumulativeMs);
      expect(entry?.cumulativeMs).toBe(readinessGiveUpBoundMs({ path }) + STEP_TIMEOUT_MS);
    });
  }

  for (const [spelled, valueMs] of [
    ['15 * 60_000', 15 * 60_000],
    ['(2 + 3) * 60_000 + 30_000', (2 + 3) * 60_000 + 30_000],
  ] as const) {
    test(`reads test.setTimeout(${spelled}) as the number it spells`, () => {
      const [entry] = extractTestEntries(
        [
          "test('declares an outer in arithmetic', async () => {",
          `  test.setTimeout(${spelled});`,
          `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
          '});',
        ].join('\n'),
        [],
      );
      expect(entry?.perTestTimeoutMs).toBe(valueMs);
    });
  }

  const UNREADABLE_OUTERS = [
    { shape: 'a name', statements: ['test.setTimeout(budgetMs);'] },
    { shape: 'another call', statements: ['test.setTimeout(computeBudgetMs(test.info()));'] },
    {
      shape: 'the derived sum with arithmetic added',
      statements: ['test.setTimeout(sumOfDeclaredBoundsMs(test.info()) - 1_000);'],
    },
    {
      shape: 'the derived sum given a second argument',
      statements: ["test.setTimeout(sumOfDeclaredBoundsMs(test.info(), 'fork'));"],
    },
    {
      shape: 'the derived sum beside a literal outer in the same body',
      statements: [
        'test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
        'test.setTimeout(200_000);',
      ],
    },
  ];

  for (const { shape, statements } of UNREADABLE_OUTERS) {
    test(`throws on ${shape}, naming its line`, () => {
      const lines = [
        "test('declares an outer the guard cannot read', async () => {",
        ...statements.map((statement) => `  ${statement}`),
        `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
        '});',
      ];
      const outerLines = statements.map((statement) => lineHolding(lines, statement));
      expect(() => extractTestEntries(lines.join('\n'), [])).toThrow(
        new RegExp(`(?:line\\W*|:)(?:${outerLines.join('|')})\\b`),
      );
    });
  }

  test('names the spec file of an outer it cannot read', () => {
    const file = writeFixture('.e2e.ts', [
      "test('declares an outer the guard cannot read', async () => {",
      '  test.setTimeout(budgetMs);',
      '});',
    ]);
    expect(() => parseTestFile(file)).toThrow(basename(file));
  });

  test('reports an outer of any shape at describe scope as loose', () => {
    const lines = [
      "test.describe('a suite', () => {",
      '  test.setTimeout(200_000);',
      '  test.setTimeout(2 * 30_000);',
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      '  test.setTimeout(budgetMs);',
      "  test('declares its own outer', async () => {",
      '    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      `    await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
      '  });',
      '});',
    ];
    const suiteScope = lines.slice(0, lineHolding(lines, "test('declares its own outer'"));
    const expectedLoose = suiteScope.flatMap((line, index) =>
      line.includes('test.setTimeout(') ? [index + 1] : [],
    );
    expect(parseTestFile(writeFixture('.e2e.ts', lines)).looseSetTimeoutLines).toEqual(
      expectedLoose,
    );
  });
});

describe('sumOfDeclaredBoundsMs reads the running test out of its own spec', () => {
  const lines = [
    "import { expect, test } from './_helpers/smoke-test';",
    '',
    "test('launches and finds the editor', async () => {",
    '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
    "  await waitForWindowByMode(app, 'editor');",
    `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
    '});',
  ];
  const file = writeFixture('.e2e.ts', lines);
  const declared: DeclaredTest = { file, line: lineHolding(lines, "test('launches") };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const path of READINESS_PATHS) {
    test(`returns the ${path} path's sum for the test declared at that line`, () => {
      const sumMs = sumOfDeclaredBoundsMs(declared, path);
      expect(sumMs).toBe(readinessGiveUpBoundMs({ path }) + STEP_TIMEOUT_MS);
      expect(sumMs).toBe(
        entryDeclaredAt(parseTestFile(file, { path }), declared.line).cumulativeMs,
      );
    });
  }

  test('throws, rather than defaulting, when no test is declared at that line', () => {
    const undeclaredLine = lineHolding(lines, 'waitForWindowByMode');
    expect(() => sumOfDeclaredBoundsMs({ file, line: undeclaredLine }, 'fork')).toThrow(
      new RegExp(`(?:line\\W*|:)${undeclaredLine}\\b`),
    );
  });

  test('takes the packaged path when OK_DESKTOP_PACKAGED_APP names a bundle', () => {
    vi.stubEnv(PACKAGED_APP_ENV, join(fixtureRoot, 'OpenKnowledge.app'));
    expect(sumOfDeclaredBoundsMs(declared)).toBe(
      readinessGiveUpBoundMs({ path: 'packaged' }) + STEP_TIMEOUT_MS,
    );
  });

  test('takes the fork path when OK_DESKTOP_PACKAGED_APP names none', () => {
    vi.stubEnv(PACKAGED_APP_ENV, '');
    expect(sumOfDeclaredBoundsMs(declared)).toBe(
      readinessGiveUpBoundMs({ path: 'fork' }) + STEP_TIMEOUT_MS,
    );
  });
});

describe('the per-test budget the guard scores a test against', () => {
  const lines = [
    "test('declares an outer below its own sum', async () => {",
    `  test.setTimeout(${STEP_TIMEOUT_MS});`,
    "  await waitForWindowByMode(app, 'editor');",
    `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
    '});',
    '',
    "test('derives its outer from its own sum', async () => {",
    '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
    "  await waitForWindowByMode(app, 'editor');",
    `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
    '});',
    '',
    "test('declares no outer', async () => {",
    `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
    '});',
  ];
  const file = writeFixture('.e2e.ts', lines);
  const scoring: PerTestScoring = { filePath: file, path: 'fork', configCiMs: CONFIG_CI_OUTER_MS };
  const declaredBy = (title: string): TestEntry =>
    entryDeclaredAt(parseTestFile(file, { path: scoring.path }), lineHolding(lines, title));

  test('is a literal outer as written, so one below its sum scores over budget', () => {
    const entry = declaredBy("test('declares an outer below its own sum'");
    const { budgetMs } = perTestBudgetMs(entry, scoring);
    expect(budgetMs).toBe(STEP_TIMEOUT_MS);
    expect(entry.cumulativeMs).toBeGreaterThan(budgetMs);
  });

  test("is a derived outer's own sum, read through sumOfDeclaredBoundsMs", () => {
    const entry = declaredBy("test('derives its outer from its own sum'");
    const { budgetMs } = perTestBudgetMs(entry, scoring);
    expect(budgetMs).toBe(sumOfDeclaredBoundsMs({ file, line: entry.lineNumber }, scoring.path));
    expect(budgetMs).toBe(entry.cumulativeMs);
  });

  test("is the config's CI outer for a test that declares none", () => {
    expect(perTestBudgetMs(declaredBy("test('declares no outer'"), scoring).budgetMs).toBe(
      CONFIG_CI_OUTER_MS,
    );
  });
});

describe('the path a charge is scored on never comes from the environment the guard runs in', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const helperWaiting = [
    'async function findEditorWindow(app: ElectronApplication): Promise<Page> {',
    "  return waitForWindowByMode(app, 'editor');",
    '}',
  ];

  const UNTIERED_CHARGES: readonly { through: string; chargesMs: () => readonly number[] }[] = [
    {
      through: 'extractReadinessBudgets',
      chargesMs: () => extractReadinessBudgets("return waitForWindowByMode(app, 'editor');"),
    },
    {
      through: 'extractHelperBudgets',
      chargesMs: () =>
        extractHelperBudgets(helperWaiting.join('\n')).map((helper) => helper.maxTimeoutMs),
    },
    {
      through: 'extractTestEntries',
      chargesMs: () =>
        extractTestEntries(
          "test('x', async () => {\n  await waitForWindowByMode(app, 'editor');\n});\n",
          [],
        )[0]?.directTimeoutsMs ?? [],
    },
    {
      through: 'parseTestFile, traced through a helper',
      chargesMs: () =>
        parseTestFile(
          writeFixture('.e2e.ts', [
            ...helperWaiting,
            '',
            "test('finds the editor through a helper', async () => {",
            '  await findEditorWindow(app);',
            '});',
          ]),
        ).tests[0]?.tracedHelperBudgetsMs ?? [],
    },
  ];

  for (const { through, chargesMs } of UNTIERED_CHARGES) {
    test(`${through} charges a wait on no named path the fork path's give-up bound when OK_DESKTOP_PACKAGED_APP names a bundle`, () => {
      vi.stubEnv(PACKAGED_APP_ENV, join(fixtureRoot, 'OpenKnowledge.app'));
      expect(chargesMs()).toEqual([readinessGiveUpBoundMs({ path: 'fork' })]);
    });
  }

  test('the per-test budget of a derived outer is its sum on the path it is scored on, when OK_DESKTOP_PACKAGED_APP names none', () => {
    vi.stubEnv(PACKAGED_APP_ENV, '');
    const lines = [
      "test('derives its outer from its own sum', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      "  await waitForWindowByMode(app, 'editor');",
      `  await expect(page).toBeVisible({ timeout: ${STEP_TIMEOUT_MS} });`,
      '});',
    ];
    const file = writeFixture('.e2e.ts', lines);
    const entry = entryDeclaredAt(
      parseTestFile(file, { path: 'packaged' }),
      lineHolding(lines, "test('derives"),
    );
    const { budgetMs } = perTestBudgetMs(entry, {
      filePath: file,
      path: 'packaged',
      configCiMs: CONFIG_CI_OUTER_MS,
    });
    expect(budgetMs).toBe(sumOfDeclaredBoundsMs({ file, line: entry.lineNumber }, 'packaged'));
    expect(budgetMs).not.toBe(sumOfDeclaredBoundsMs({ file, line: entry.lineNumber }, 'fork'));
  });
});

describe('the config outer a local run takes can be the derived one-launch outer', () => {
  const configWithLocalBranch = (name: string): string =>
    writeFixture('.config.ts', [
      "import { defineConfig } from '@playwright/test';",
      `import { ${name} } from './tests/smoke/_helpers/launch-desktop';`,
      '',
      'export default defineConfig({',
      `  timeout: process.env.CI ? ${CONFIG_CI_OUTER_MS} : ${name},`,
      '});',
    ]);

  test('resolves that local branch to the value launch-desktop exports under the name', () => {
    const config = configWithLocalBranch('ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS');
    expect(() => parsePlaywrightConfigTimeout(config)).not.toThrow();
    expect(parsePlaywrightConfigTimeout(config)).toMatchObject({
      ci: CONFIG_CI_OUTER_MS,
      local: ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS,
    });
  });

  test("refuses any other name in that branch, where the derived outer's name parses", () => {
    expect(() =>
      parsePlaywrightConfigTimeout(
        configWithLocalBranch('ONE_LAUNCH_AND_ITS_READINESS_VERDICT_MS'),
      ),
    ).not.toThrow();
    expect(() => parsePlaywrightConfigTimeout(configWithLocalBranch('OTHER_NAME'))).toThrow(
      /OTHER_NAME/,
    );
  });
});

describe('the outer a test derives from its parsed charge', () => {
  test('keeps a test whose own sum exceeds the timeout in force at its own sum', () => {
    const lines = [
      "test('finds its editor', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      "  await waitForWindowByMode(app, 'editor');",
      '});',
    ];
    const declared = {
      file: writeFixture('.e2e.ts', lines),
      line: lineHolding(lines, "test('finds"),
    };
    const sumMs = readinessGiveUpBoundMs({ path: 'fork' });
    expect(STEP_TIMEOUT_MS).toBeLessThan(sumMs);
    expect(sumOfDeclaredBoundsMs({ ...declared, timeout: STEP_TIMEOUT_MS }, 'fork')).toBe(sumMs);
  });

  test('keeps a test whose waits it cannot charge under the timeout in force, never under none', () => {
    const lines = [
      "test('finds its editor through a helper another module declares', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      '  await findEditorWindowElsewhere(app);',
      '});',
    ];
    const declared = {
      file: writeFixture('.e2e.ts', lines),
      line: lineHolding(lines, "test('finds"),
    };
    const inForceMs = parsePlaywrightConfigTimeout(DESKTOP_PLAYWRIGHT_CONFIG).ci;
    expect(sumOfDeclaredBoundsMs(declared, 'fork')).toBe(0);
    expect(sumOfDeclaredBoundsMs({ ...declared, timeout: inForceMs }, 'fork')).toBe(inForceMs);
  });

  test('leaves a test that runs with no timeout, as --debug runs it, with none', () => {
    const lines = [
      "test('finds its editor', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      "  await waitForWindowByMode(app, 'editor');",
      '});',
    ];
    const declared = {
      file: writeFixture('.e2e.ts', lines),
      line: lineHolding(lines, "test('finds"),
    };
    expect(sumOfDeclaredBoundsMs(declared, 'fork')).toBe(readinessGiveUpBoundMs({ path: 'fork' }));
    expect(sumOfDeclaredBoundsMs({ ...declared, timeout: 0 }, 'fork')).toBe(0);
  });

  describe('resolves a test declared through a modifier whose body Playwright runs', () => {
    const headers = ['test.only(', 'test.fail(', 'test.fail.only('];
    const lines = headers.flatMap((header) => [
      `${header}'is declared through ${header.slice(0, -1)}', async () => {`,
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      "  await waitForWindowByMode(app, 'editor');",
      '});',
      '',
    ]);
    const file = writeFixture('.e2e.ts', lines);

    for (const header of headers) {
      test(`${header} resolves to the sum of the test it declares`, () => {
        expect(sumOfDeclaredBoundsMs({ file, line: lineHolding(lines, header) }, 'fork')).toBe(
          readinessGiveUpBoundMs({ path: 'fork' }),
        );
      });
    }

    test('the guard audits every one of them', () => {
      expect(parseTestFile(file).tests.map((t) => t.lineNumber)).toEqual(
        headers.map((header) => lineHolding(lines, header)),
      );
    });
  });

  describe('reads only the declarations the running test makes', () => {
    const lines = [
      'async function findWindowTheGuardCannotCharge(app: ElectronApplication): Promise<Page> {',
      "  return waitForWindowByMode(app, 'editor', { capMs: CAP });",
      '}',
      '',
      "test('declares an outer the guard cannot read', async () => {",
      '  test.setTimeout(budgetMs);',
      '});',
      '',
      "test('derives its outer beside them', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      "  await waitForWindowByMode(app, 'editor');",
      '});',
      '',
      "test('derives its outer through the helper the guard cannot charge', async () => {",
      '  test.setTimeout(sumOfDeclaredBoundsMs(test.info()));',
      '  await findWindowTheGuardCannotCharge(app);',
      '});',
    ];
    const file = writeFixture('.e2e.ts', lines);
    const unreadableCallAt = `${file}:${lineHolding(lines, '{ capMs: CAP }')}`;

    test('a test that calls none of them resolves to its own sum', () => {
      expect(
        sumOfDeclaredBoundsMs(
          { file, line: lineHolding(lines, "test('derives its outer beside") },
          'fork',
        ),
      ).toBe(readinessGiveUpBoundMs({ path: 'fork' }));
    });

    test('a test that calls the helper it cannot charge is refused, naming that call', () => {
      expect(() =>
        sumOfDeclaredBoundsMs(
          { file, line: lineHolding(lines, "test('derives its outer through") },
          'fork',
        ),
      ).toThrow(unreadableCallAt);
    });

    test('the guard still refuses the spec, naming the call it cannot read', () => {
      expect(() => parseTestFile(file)).toThrow(unreadableCallAt);
    });
  });

  test('the guard names where a test body calls the readiness wait with options it cannot read', () => {
    const lines = [
      "test('stalls on a bound the guard cannot read', async () => {",
      "  await waitForWindowByMode(app, 'editor', { stallMs: STALL });",
      '});',
    ];
    const file = writeFixture('.e2e.ts', lines);
    expect(() => parseTestFile(file)).toThrow(
      `${file}:${lineHolding(lines, '{ stallMs: STALL }')}`,
    );
  });
});
