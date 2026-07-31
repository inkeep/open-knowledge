import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { projectHarnessHomes } from './harness-homes.ts';

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
