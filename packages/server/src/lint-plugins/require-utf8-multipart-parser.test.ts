/**
 * Multipart filename charset correctness — `require-utf8-multipart-parser`
 * GritQL plugin.
 *
 * Plugin:  `biome-plugins/require-utf8-multipart-parser.grit`
 * Fixture: `biome-plugins/__fixtures__/require-utf8-multipart-parser.fixture.tsx`
 *
 * The fixture pairs 3 positive cases (a `busboy(...)` with no charset declared —
 * the shape that shipped the bug — plus one with an explicit `latin1` and one
 * with an inline `utf8`) against negatives: the sanctioned
 * `createMultipartParser(...)` call, a `ReturnType<typeof busboy>` type
 * annotation, a member call, and an unrelated identifier.
 *
 * The `latin1` positive is the load-bearing one. It is what separates this
 * presence-match rule from the absence-match shape a sibling rule uses: "a
 * `busboy(...)` call must contain `defParamCharset:`" would wave that line
 * through and reintroduce the defect while passing lint. The type-annotation
 * negative is the other: it pins that the pattern does not reach type positions,
 * so a future widening cannot start flagging them silently.
 *
 * Exact equality on the fire count catches drift in both directions — a
 * false-negative regression (< 3) and a false-positive widening (> 3).
 *
 * The plugin is registered via `overrides[].plugins` in `biome.jsonc`, repo-wide
 * rather than per-package (server owns the only busboy dependency today, which is
 * the state a new dependency elsewhere would change silently), with the factory
 * module and tests excluded.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/require-utf8-multipart-parser.fixture.tsx';
const PLUGIN_REL = './biome-plugins/require-utf8-multipart-parser.grit';

describe('require-utf8-multipart-parser GritQL plugin', () => {
  test('fires exactly 3 times — one per direct busboy construction', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    // Guard against a vacuous pass if `pnpm exec biome` itself fails to spawn
    // (missing binary / PATH) — `result.status` would be null and `not.toBe(0)`
    // would pass while asserting nothing about biome's output.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/busboy constructed directly/g) ?? []).length;
    expect(fires).toBe(3);

    // Message names the fix as an action, and links the docs.
    expect(output).toContain('createMultipartParser');
    expect(output).toContain('packages/server/src/multipart.ts');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#require-utf8-multipart-parsergrit');
  });

  test('the factory module itself is exempt, so the sanctioned call passes', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'biome', 'check', 'packages/server/src/multipart.ts'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}\n${result.stderr}`;
    // Proves biome actually visited the file, so the `not.toContain` below is a
    // real negative rather than a vacuous one. Asserting `status === 0` instead
    // would fail this test for any unrelated formatting nit in `multipart.ts`.
    expect(output).toMatch(/Checked \d+ file/);
    expect(output).not.toContain('busboy constructed directly');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) => (entry.plugins ?? []).includes(PLUGIN_REL));
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    // Repo-wide, not per-package: the invariant is "no direct construction
    // anywhere", and a busboy dependency added outside server is precisely the
    // change a server-scoped glob would wave through.
    expect(includes).toContain('**/*.ts');
    expect(includes).toContain('**/*.tsx');
    expect(includes).toContain('**/*.mts');
    expect(includes).not.toContain('packages/server/src/**/*.ts');
    // The factory is the one sanctioned construction site.
    expect(includes).toContain('!packages/server/src/multipart.ts');
    expect(includes).toContain('!**/*.test.ts');
    // Fixture self-include so this test's positive cases still trigger.
    expect(includes).toContain(FIXTURE_REL);
  });
});
