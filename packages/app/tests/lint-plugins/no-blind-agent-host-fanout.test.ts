/**
 * no-blind-agent-host-fanout — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-blind-agent-host-fanout.grit`
 * Fixture: `biome-plugins/__fixtures__/no-blind-agent-host-fanout.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). Forbids
 * re-introducing the `npx skills … --agent '*'` shell-out that made `ok init`
 * create skill directories in every host the third-party CLI knows about,
 * including ~51 for tools the user had never installed (issue #820). OK now
 * writes the user-global bundle itself, gated on `detectUserSkillHosts`.
 *
 * Three guarantees, each its own test:
 *   1. Fires on exactly the planted positives (and on no negative) — the
 *      bidirectional `toBe(5)` count, plus the diagnostic-message contract.
 *   2. Registered as an override scoped to the packages that own the install,
 *      with tests deliberately IN scope.
 *   3. The banned npm-spec arms cover every range shape of the pinned spec the
 *      incident shipped with, so a caret/exact/latest variant can't slip past a
 *      guard written only against the tilde form.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-blind-agent-host-fanout.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-blind-agent-host-fanout.grit';
const GRIT_ABS = join(REPO_ROOT, 'biome-plugins/no-blind-agent-host-fanout.grit');

describe('no-blind-agent-host-fanout GritQL plugin', () => {
  test('fires on exactly 5 planted positives (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (
      output.match(/User-global skill installs must be gated on detected hosts/g) ?? []
    ).length;
    expect(fires).toBe(5);
    expect(output).toContain('detectUserSkillHosts');
    expect(output).toContain('HOSTS_WITH_USER_SKILL_DIR');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-blind-agent-host-fanoutgrit');
  });

  test('registered as an override over the packages that own the install, tests included', () => {
    const config = readBiomeConfig(REPO_ROOT);
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    expect(includes).toContain(FIXTURE_REL);
    expect(includes).toContain('packages/server/src/**/*.ts');
    expect(includes).toContain('packages/cli/src/**/*.ts');
    for (const excluded of ['!**/*.test.ts', '!**/*.test-helper.ts']) {
      expect(includes).not.toContain(excluded);
    }
  });

  test('bans every range shape of the spec, not just the one that shipped', () => {
    const gritArms = readFileSync(GRIT_ABS, 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const matched = [...gritArms.matchAll(/`'([^']+)'`/g)].map((m) => m[1]).sort();
    expect(matched.length).toBeGreaterThan(0);
    for (const spec of ['skills@~1.5.0', 'skills@^1.5.0', 'skills@1.5.0', 'skills@latest']) {
      expect(matched).toContain(spec);
    }
    expect(matched).toContain('--agent');
  });
});
