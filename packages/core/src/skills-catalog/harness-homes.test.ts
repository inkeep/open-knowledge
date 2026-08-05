import { join, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { harnessHomes, projectHarnessHomes, userGlobalSkillRoots } from './harness-homes.ts';

describe('projectHarnessHomes', () => {
  test('uses project roots for hosts whose user and project layouts differ', () => {
    const projectDir = '/workspace/project';
    const byHarness = new Map(
      projectHarnessHomes(projectDir).map(({ harness, dir }) => [harness, dir]),
    );

    expect(byHarness.get('copilot')).toBe(join(projectDir, '.github', 'skills'));
    expect(byHarness.get('pi')).toBe(join(projectDir, '.pi', 'skills'));
  });

  test('omits user-only skill hosts from project scanning', () => {
    const harnesses = projectHarnessHomes('/workspace/project').map(({ harness }) => harness);

    expect(harnesses).not.toContain('antigravity');
    expect(harnesses).not.toContain('openclaw');
    expect(harnesses).not.toContain('claude-desktop');
  });
});

describe('userGlobalSkillRoots', () => {
  test('covers every harness home plus the `.ok/skills` store', () => {
    const home = '/Users/tester';
    const roots = userGlobalSkillRoots(home);

    for (const { dir } of harnessHomes(home)) expect(roots).toContain(dir);
    // The loop above shrinks with the production function, so it would pass
    // vacuously if a root were dropped. These spell out the whole expected set
    // independently — one per source: the store, an editor dir, the vendor-
    // neutral hub, and the plugin-provider cache.
    expect(roots).toContain(join(home, '.ok', 'skills'));
    expect(roots).toContain(join(home, '.claude', 'skills'));
    expect(roots).toContain(join(home, '.agents', 'skills'));
    expect(roots).toContain(join(home, '.claude', 'plugins'));
  });

  test('stays under the given home — it is a containment allowlist, not a home pass', () => {
    const home = '/Users/tester';
    for (const root of userGlobalSkillRoots(home)) {
      // `sep`, not a literal '/': the function builds paths with `join`, so a
      // POSIX-only assertion would be false on win32 (a shipping desktop target).
      expect(root.startsWith(`${home}${sep}`)).toBe(true);
      expect(root).not.toBe(home);
    }
  });
});
