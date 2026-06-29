import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractHelperBudgets,
  extractTestEntries,
  parseNumericLiteral,
  parsePlaywrightConfigTimeout,
  parseTestFile,
  stripCommentsAndStrings,
} from './parse-timeouts';

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
  test('consent-dialog.e2e.ts yields helpers + tests', () => {
    const fa = parseTestFile(join(__dirname, '..', 'consent-dialog.e2e.ts'));
    expect(fa.helpers.length).toBeGreaterThan(0);
    expect(fa.tests.length).toBeGreaterThanOrEqual(3);
    const byName = new Map(fa.helpers.map((h) => [h.name, h.maxTimeoutMs]));
    expect(byName.get('launchApp') ?? 0).toBeGreaterThan(0);
    expect(byName.get('findWindowByMode') ?? 0).toBeGreaterThan(0);
  });
});
