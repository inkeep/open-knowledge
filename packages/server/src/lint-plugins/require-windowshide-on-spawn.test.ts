/**
 * Windows console-flash prevention — `require-windowshide-on-spawn` GritQL
 * plugin.
 *
 * Plugin:  `biome-plugins/require-windowshide-on-spawn.grit`
 * Fixture: `biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx`
 *
 * The fixture pairs 7 positive cases (spawn / spawnSync / execFile /
 * execFileSync / execSync / nodeSpawn / execFileAsync, each hiding the console
 * via NEITHER `windowsHide: true` NOR `withHiddenWindowsConsole(...)`) with
 * negatives (inline flag, the helper in both forms, a member call, a
 * differently-named helper, and bare `exec`). Exact equality on the fire count
 * catches drift in both directions — a false-negative regression (< 7) and a
 * false-positive widening (> 7). The helper-form negatives specifically guard
 * that the rule accepts #2514's `withHiddenWindowsConsole(...)` wrapping.
 *
 * The plugin is registered via `overrides[].plugins` in `biome.jsonc`, scoped
 * to `packages/{server,cli}/src/**` (the packages that spawn processes on
 * Windows; `packages/desktop` is macOS-only and out of scope) with tests
 * excluded.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx';

describe('require-windowshide-on-spawn GritQL plugin', () => {
  test('fires exactly 7 times — one per spawn that hides neither way', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    // Guard against a vacuous pass if `pnpm exec biome` itself fails to spawn (missing
    // binary / PATH) — `result.status` would be null and `not.toBe(0)` would
    // pass while asserting nothing about biome's output.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/without a hidden Windows console/g) ?? []).length;
    expect(fires).toBe(7);

    // Message names the fix (the helper + the inline flag) + links the docs.
    expect(output).toContain('withHiddenWindowsConsole');
    expect(output).toContain('windowsHide: true');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#require-windowshide-on-spawngrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/require-windowshide-on-spawn.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/require-windowshide-on-spawn.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    // Scoped to the runtime-spawning packages (server + cli), tests excluded.
    // desktop is macOS-only, deliberately absent.
    expect(includes).toContain('packages/server/src/**/*.ts');
    expect(includes).toContain('packages/cli/src/**/*.ts');
    expect(includes).not.toContain('packages/desktop/src/**/*.ts');
    expect(includes).toContain('!**/*.test.ts');
    // Fixture self-include so this test's positive cases still trigger.
    expect(includes).toContain(
      'biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx',
    );
  });
});
