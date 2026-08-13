import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { managedArtifactSkillsRoots } from './managed-artifact-persistence.ts';
import {
  type ManagedArtifactWatcherUnsubscribe,
  startManagedArtifactWatcher,
} from './managed-artifact-watcher.ts';

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

// Poll until `predicate` is true or the deadline elapses (watcher is async).
async function eventually(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('eventually: predicate never became true');
}

// These two assert real chokidar event delivery (create/edit a file, wait for
// onChange). The watcher uses `usePolling: true`, whose detection depends on a
// setInterval firing on the event loop. macOS (the only supported platform) runs
// them fast, but on the Linux CI runner the whole server suite shares one
// saturated event loop, so the poll never gets a tick within even a 20s deadline
// and the file change is missed. Gate them off CI — the watcher's wiring is
// verified locally on the supported platform; CI keeps the rest of the suite.
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

    await eventually(() => seen.some(([p, c]) => p === leaf && c === 'v1'));
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

    // Deletion drives the list-refresh callback, not the reconcile-into-open-doc path.
    await eventually(() => unlinked.includes(leaf));
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

    // A non-SKILL.md sibling must never fire.
    writeFileSync(resolve(skillDir, 'NOTES.md'), 'noise', 'utf-8');
    writeFileSync(leaf, 'v2', 'utf-8');

    await eventually(() => contents.includes('v2'));
    expect(contents).not.toContain('noise');
  }, 25_000);
});

/**
 * The branch invariant: OK never CREATES a harness home, it only writes into
 * one that already exists. This watcher is where that broke — it `mkdir -p`s
 * every root handed to it, and the roots list was the full vocabulary, so
 * booting a server against a home with only `.claude` grew `.codex`,
 * `.copilot`, `.cursor`, `.opencode` and `.pi` before a single skill was
 * written. Asserted as "no dotdir the home did not start with", not as a list
 * of the five that leaked, so a newly onboarded editor is covered too.
 */
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
    // …and the one host that IS installed still gets its watchable skills leaf.
    expect(existsSync(resolve(root, '.claude', 'skills'))).toBe(true);
  }, 25_000);
});
