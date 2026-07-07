/**
 * playwright-prefer-to-have-count — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/playwright-prefer-to-have-count.grit`
 * Fixture: `biome-plugins/__fixtures__/playwright-prefer-to-have-count.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). Bans the
 * one-shot `expect(await locator.count())` snapshot read in the browser
 * e2e suites — the no-retry assertion shape behind hidden flakes — in
 * favor of the web-first auto-retrying
 * `await expect(locator).toHaveCount(n)`. Upstream precedent:
 * eslint-plugin-playwright `prefer-to-have-count`.
 *
 * The fixture pairs 3 positive cases (one-shot reads through different
 * matchers — plugin must fire) with 5 negative cases (toHaveCount,
 * expect.poll, bare count read, different awaited method, two-statement
 * read-then-assert — plugin must NOT fire). Exact-equality (`toBe(3)`)
 * catches both false-negative regressions (weakened pattern drops below 3)
 * and false-positive widenings (above 3).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/playwright-prefer-to-have-count.fixture.tsx';
const PLUGIN_REL = './biome-plugins/playwright-prefer-to-have-count.grit';

describe('playwright-prefer-to-have-count GritQL plugin', () => {
  test('fires on exactly 3 one-shot count reads (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    // biome check exits non-zero when any diagnostic (incl. plugin) fires.
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/One-shot count read never retries/g) ?? []).length;
    expect(fires).toBe(3);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('use the web-first `await expect(locator).toHaveCount(n)`');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#playwright-prefer-to-have-countgrit');
  });

  test('plugin is registered as an override scoped to the e2e suites (not workspace-wide)', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    // NOT at root plugins[] — an accidental promotion to workspace-wide
    // would fire on non-Playwright `.count()` methods and over-report.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing test above can trigger
    // the rule at all, and every browser-e2e dir the e2e-stop-rules
    // source-scan covers must be in scope so real specs are gated.
    expect(includes).toContain(FIXTURE_REL);
    for (const dir of ['stress', 'visual', 'a11y']) {
      expect(includes).toContain(`packages/app/tests/${dir}/**/*.e2e.ts`);
    }
  });
});
