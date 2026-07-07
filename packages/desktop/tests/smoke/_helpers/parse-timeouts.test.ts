/**
 * Pinning tests for the `parse-timeouts.ts` static parser used by the
 * timeout-calibration check. The calibration assertion is only meaningful if
 * the parser correctly attributes inner timeouts — these tests pin its
 * behavior on synthetic inputs that mirror the shapes used in real smoke
 * files (consent-dialog.e2e.ts / deep-link.e2e.ts / external-link.e2e.ts).
 *
 * The synthetic inputs are inlined as strings rather than reading from
 * disk so this test stays deterministic regardless of the real files'
 * current state.
 */

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
  /* block */
  return \`tpl-\${a}\`;
}`;
    const out = stripCommentsAndStrings(src);
    expect(out.length).toBe(src.length);
    // Newlines inside the source are preserved so line numbers stay aligned.
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  test('handles escaped quotes inside single-quote strings', () => {
    // Source text (8 chars including outer quotes): ' d o n \ ' t '
    // The escaped \' must not terminate the string early; the closing
    // quote is the trailing apostrophe.
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
    // The function-header regex would match `function test(...)` if the
    // codebase ever defined one — the helper extractor skips by name.
    const src = `
function test(name: string) { /* timeout: 99_000 */ }
function describe(name: string) { /* timeout: 99_000 */ }
function helper(timeoutMs = 5_000) { return 1; }
`;
    const helpers = extractHelperBudgets(src);
    // `test` and `describe` body lines are inside JS comments so wouldn't
    // contribute timeouts anyway, but the by-name skip is the intentional
    // guard. `helper` is captured.
    expect(helpers).toEqual([{ name: 'helper', maxTimeoutMs: 5000 }]);
  });

  test('helper with multiple timeout literals reports MAX, not SUM', () => {
    // A helper that performs several timeout-bounded awaits in sequence
    // doesn't spend their sum — at worst it spends the largest of them
    // (subsequent ones bail early once the work is done). The cumulative
    // calibration would over-count if extractHelperBudgets summed.
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
    // Documented limitation: a helper that takes `timeoutMs: number` (no
    // default literal) and uses it as `{ timeout: timeoutMs }` has no
    // static budget — the parser cannot know the caller's value. Static
    // parser can't peer into call sites; addressing this would require an
    // AST pass or a Biome GritQL rule (tracked as a follow-up).
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
    // toPass budgets are ALSO direct timeout literals, so they appear in both.
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
    // 30_000 (launchApp) + 20_000 (findWindowByMode) + 15_000 (toBeVisible) = 65_000
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
    // A commented-out `// launchApp();` was previously double-counted because
    // the call-detection regex scanned the raw body. The stripped-body pass
    // means commented helper references contribute nothing to the cumulative.
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
    // A helper name appearing inside an error message string was previously
    // matched by the call-detection regex (followed by `(` in the literal).
    // The stripped-body pass blanks string contents so the false match is
    // suppressed.
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
    // When a test conditionally calls setTimeout in multiple branches
    // (e.g. `if (process.env.CI) test.setTimeout(240_000); else
    // test.setTimeout(120_000);`), the cumulative invariant must hold for
    // the LARGEST budget the test might run under.
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
    // String-literal and commented-out setTimeout calls must not be
    // attributed as overrides — same hygiene as helper-call detection.
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

  beforeAll(() => {
    // tmpdirRoot already mkdtemp'd at module load.
  });

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
    // A stale `// timeout: 30_000, before bump` comment above the real
    // config used to be the first match. After stripping comments, the
    // regex matches the actual `timeout:` key inside `defineConfig`.
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
  // Sanity check: parsing the real consent-dialog smoke file should yield
  // at least one helper with a non-zero budget and at least three tests.
  // This catches regressions like "the regex stopped matching async
  // functions" or "the test header regex broke" without coupling to the
  // specific numeric budgets in the real file (which legitimately drift as
  // the smoke suite evolves). The synthetic-input tests above are where
  // exact numeric attribution is pinned — those use controlled inputs.
  test('consent-dialog.e2e.ts yields helpers + tests', () => {
    const fa = parseTestFile(join(__dirname, '..', 'consent-dialog.e2e.ts'));
    expect(fa.helpers.length).toBeGreaterThan(0);
    expect(fa.tests.length).toBeGreaterThanOrEqual(3);
    // launchApp and findWindowByMode are the load-bearing helpers in
    // consent-dialog.e2e.ts; both should be detected as helpers with a
    // non-zero budget. We deliberately do NOT pin the exact ms values —
    // a future change to electron.launch's or findWindowByMode's budget
    // is an authoring choice in the smoke file, not a parser regression.
    const byName = new Map(fa.helpers.map((h) => [h.name, h.maxTimeoutMs]));
    expect(byName.get('launchApp') ?? 0).toBeGreaterThan(0);
    expect(byName.get('findWindowByMode') ?? 0).toBeGreaterThan(0);
  });
});
