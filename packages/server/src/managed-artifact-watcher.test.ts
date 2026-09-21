import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { managedArtifactSkillsRoots } from './managed-artifact-persistence.ts';
import {
  type ManagedArtifactWatcherUnsubscribe,
  startManagedArtifactWatcher,
} from './managed-artifact-watcher.ts';
import { waitWithinTestBudget } from './wait-within-test-budget.test-helper.ts';

let root: string;
let cleanup: ManagedArtifactWatcherUnsubscribe | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-ma-watch-'));
});
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  rmSync(root, { recursive: true, force: true });
});

const RUNNING_IN_CI = Boolean(process.env.CI);

describe.skipIf(RUNNING_IN_CI)('startManagedArtifactWatcher', () => {
  test('fires onChange for a SKILL.md created after start', async () => {
    const skillsRoot = resolve(root, '.ok', 'skills');
    const seen: Array<[string, string]> = [];
    cleanup = await startManagedArtifactWatcher([skillsRoot], (p, c) => seen.push([p, c]));

    const skillDir = resolve(skillsRoot, 'demo');
    mkdirSync(skillDir, { recursive: true });
    const leaf = resolve(skillDir, 'SKILL.md');
    writeFileSync(leaf, 'v1', 'utf-8');

    await waitWithinTestBudget(
      "the watcher to report the new SKILL.md with its 'v1' contents",
      () => seen.some(([p, c]) => p === leaf && c === 'v1'),
      { timeoutMs: 20_000, pollMs: 50 },
    );
  }, 25_000);

  test('fires onUnlink (not onChange) when a SKILL.md is deleted', async () => {
    const skillsRoot = resolve(root, '.ok', 'skills');
    const skillDir = resolve(skillsRoot, 'demo');
    mkdirSync(skillDir, { recursive: true });
    const leaf = resolve(skillDir, 'SKILL.md');
    writeFileSync(leaf, 'v1', 'utf-8');

    const changed: string[] = [];
    const unlinked: string[] = [];
    cleanup = await startManagedArtifactWatcher(
      [skillsRoot],
      (p) => changed.push(p),
      (p) => unlinked.push(p),
    );

    rmSync(leaf, { force: true });

    await waitWithinTestBudget(
      'the watcher to report the deleted SKILL.md as unlinked',
      () => unlinked.includes(leaf),
      { timeoutMs: 20_000, pollMs: 50 },
    );
    expect(changed).not.toContain(leaf);
  }, 25_000);

  test('fires onChange on edit; ignores non-SKILL.md siblings', async () => {
    const skillsRoot = resolve(root, '.ok', 'skills');
    const skillDir = resolve(skillsRoot, 'demo');
    mkdirSync(skillDir, { recursive: true });
    const leaf = resolve(skillDir, 'SKILL.md');
    writeFileSync(leaf, 'v1', 'utf-8');

    const contents: string[] = [];
    cleanup = await startManagedArtifactWatcher([skillsRoot], (_p, c) => contents.push(c));

    writeFileSync(resolve(skillDir, 'NOTES.md'), 'noise', 'utf-8');
    writeFileSync(leaf, 'v2', 'utf-8');

    await waitWithinTestBudget(
      "the watcher to report the edited SKILL.md with its 'v2' contents",
      () => contents.includes('v2'),
      { timeoutMs: 20_000, pollMs: 50 },
    );
    expect(contents).not.toContain('noise');
  }, 25_000);
});

describe('managed-artifact watch roots never conjure a harness home', () => {
  test('booting the watcher against a home with only .claude adds no host dotdir', async () => {
    mkdirSync(join(root, '.claude'));
    const before = readdirSync(root).sort();

    cleanup = await startManagedArtifactWatcher(
      managedArtifactSkillsRoots({
        projectDir: root,
        homedirOverride: root,
        lkgCache: new Map<string, string>(),
        setReconciledBase: () => {},
        getReconciledBase: () => undefined,
      }),
      () => {},
    );

    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(resolve(root, '.claude', 'skills'))).toBe(true);
  }, 25_000);
});
