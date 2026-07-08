/**
 * Unit tests for SyncEngine — state machine, persistence, backoff, and lifecycle.
 *
 * These tests exercise the parts of SyncEngine that don't require a real git
 * repository: state transitions, state persistence round-trip, backoff levels,
 * and `stop()` idempotency.
 *
 * Tests that need live git operations (pull cycle, push cycle, conflict
 * detection) belong in a future integration test that spins up a bare git repo.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// This suite runs in CI despite oven-sh/bun#11892 (Bun fails to kill/reap
// spawned child processes on GitHub Actions runners; still open upstream).
// Two facts make that safe here: the suite only spawns short-lived git
// children via simple-git — not the long-lived spawn+kill pattern from the
// bun issue — and the bare-remote fixtures pin their branch explicitly, so
// the suite passes under CI's `master`-default git
// (inkeep/open-knowledge#361). If this file ever flakes or hangs in CI,
// narrow to a targeted skip of the specific live-git describe blocks —
// do not restore a blanket process.env.CI gate.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { classifyGitError } from './error-classification.ts';
import { listNames } from './git-paths.ts';
import type { DetectGhFn } from './github-permissions.ts';
import type { SyncState } from './sync-engine.ts';
import { SyncEngine } from './sync-engine.ts';

// ─── Minimal ContentFilter stub ───────────────────────────────────────────────

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

// ─── Temp dir fixtures ────────────────────────────────────────────────────────

let tmpDir = '';
let projectDir = '';
let contentDir = '';
let okDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-test-'));
  projectDir = join(tmpDir, 'project');
  contentDir = join(tmpDir, 'content');
  okDir = join(projectDir, '.ok', LOCAL_DIR);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(okDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(opts: { syncEnabled?: boolean; onStateChange?: (s: SyncState) => void } = {}) {
  return new SyncEngine({
    projectDir,
    contentDir,
    contentFilter: stubContentFilter,
    syncEnabled: opts.syncEnabled,
    onStateChange: opts.onStateChange,
  });
}

// ─── Push-permission probe fixtures ───────────────────────────────────────────

/**
 * Initialise `projectDir` as a git repo with origin pointing at the given URL
 * (defaults to a github.com origin so the probe runs). Returns the project's
 * `simpleGit` handle for further setup. Used by the push-permission probe
 * tests below.
 */
async function initGitWithOrigin(originUrl = 'https://github.com/inkeep/open-knowledge.git') {
  const git = simpleGit(projectDir);
  await git.init(['--initial-branch=main']);
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(join(projectDir, 'README.md'), 'seed\n', 'utf-8');
  await git.add('.');
  await git.commit('seed');
  await git.addRemote('origin', originUrl);
  return git;
}

interface FakeProbeRecorder {
  calls: number;
  next: import('./github-permissions.ts').PushPermission[];
  fn: (
    opts: import('./github-permissions.ts').CheckPushPermissionOptions,
  ) => Promise<import('./github-permissions.ts').PushPermission>;
}

function fakeProbe(...sequence: Array<import('./github-permissions.ts').PushPermission>) {
  const rec: FakeProbeRecorder = {
    calls: 0,
    next: [...sequence],
    fn: async () => {
      rec.calls++;
      return rec.next.shift() ?? { kind: 'unknown', error: 'network' };
    },
  };
  return rec;
}

function makeProbeEngine(opts: { syncEnabled?: boolean; fakeProbe: FakeProbeRecorder['fn'] }) {
  return new SyncEngine({
    projectDir,
    contentDir,
    contentFilter: stubContentFilter,
    syncEnabled: opts.syncEnabled,
    checkPushPermissionFn: opts.fakeProbe,
  });
}

/**
 * Poll until the engine has recorded a non-undefined push-permission
 * status (or until `timeoutMs` elapses). Replaces fixed `setTimeout(20)`
 * waits in earlier drafts — those failed under CI load when the microtask
 * queue took longer than 20ms to drain. This predicate is deterministic:
 * succeeds the moment the engine writes its first probe result.
 */
async function waitForPushPermissionResolved(engine: SyncEngine, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (engine.getStatus().pushPermission === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`push-permission probe did not resolve within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─── State machine ────────────────────────────────────────────────────────────

describe('SyncEngine initial state', () => {
  test('starts in dormant state', () => {
    const engine = makeEngine();
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('stays dormant when syncEnabled is explicitly false', async () => {
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().state).toBe('dormant');
  });
});

describe('SyncEngine stop()', () => {
  test('transitions from dormant to dormant without error', () => {
    const engine = makeEngine();
    engine.stop();
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('onStateChange is NOT called when stop() is a no-op (already dormant)', () => {
    const calls: SyncState[] = [];
    const engine = makeEngine({ onStateChange: (s) => calls.push(s) });
    engine.stop();
    expect(calls).toEqual([]);
  });
});

describe('SyncEngine destroy()', () => {
  test('is safe to call when never started', async () => {
    const engine = makeEngine();
    await expect(engine.destroy()).resolves.toBeUndefined();
    expect(engine.getStatus().state).toBe('dormant');
  });
});

// ─── State persistence ────────────────────────────────────────────────────────

describe('SyncEngine state persistence round-trip', () => {
  const statePath = () => join(okDir, 'sync-state.json');

  test('saveStateNow via destroy() writes sync-state.json', async () => {
    const engine = makeEngine();
    await engine.destroy(); // triggers saveStateNow() inside stop()
    // File is written even when state is empty/dormant
    expect(existsSync(statePath())).toBe(true);
  });

  test('sync-state.json does not persist the config-owned enabled preference', async () => {
    const engine = makeEngine({ syncEnabled: true });
    await engine.destroy();
    const persisted = JSON.parse(readFileSync(statePath(), 'utf-8')) as Record<string, unknown>;
    expect(persisted.syncEnabled).toBeUndefined();
  });

  test('restores consecutiveFailures from disk on start()', async () => {
    // Pre-write a state file with consecutiveFailures=4
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 4,
      inflightConflicts: [],
    };
    writeFileSync(statePath(), JSON.stringify(persisted), 'utf-8');

    // start() with syncEnabled=false so it doesn't hit git — just loads state
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    // The persisted consecutive failures should be loaded
    expect(engine.getStatus().consecutiveFailures).toBe(4);
  });

  test('ignores legacy syncEnabled from sync-state.json', async () => {
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 0,
      inflightConflicts: [],
      syncEnabled: true,
    };
    writeFileSync(statePath(), JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().syncEnabled).toBe(false);
  });

  test('restores inflightConflicts into conflictCount', async () => {
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 0,
      inflightConflicts: ['docs/a.md', 'docs/b.md'],
    };
    writeFileSync(statePath(), JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().conflictCount).toBe(2);
  });

  /**
   * Set up a project repo with a real in-progress merge conflict on the given
   * files. After this returns: `.git/MERGE_HEAD` exists and each file appears
   * in `git diff --name-only --diff-filter=U`.
   */
  async function setupRealMergeConflict(files: string[]): Promise<void> {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    // Base commit with all files
    for (const f of files) {
      const dir = join(projectDir, f, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(projectDir, f), 'base\n', 'utf-8');
    }
    await git.add('.');
    await git.commit('base');
    // Feature branch diverges
    await git.checkoutLocalBranch('feature');
    for (const f of files) writeFileSync(join(projectDir, f), 'feature\n', 'utf-8');
    await git.add('.');
    await git.commit('feature changes');
    // Main also diverges, then merging feature conflicts on every file
    await git.checkout('main');
    for (const f of files) writeFileSync(join(projectDir, f), 'main\n', 'utf-8');
    await git.add('.');
    await git.commit('main changes');
    try {
      await git.merge(['feature']);
    } catch {
      // Expected — merge throws on conflict; MERGE_HEAD + unmerged stages now exist.
    }
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
  }

  // Regression: state must transition to 'conflict' whenever conflictCount > 0
  // on restart AND git agrees (MERGE_HEAD + unmerged stages present). Otherwise
  // the ConflictBanner + paused sync UI won't render and the user sees only the
  // stale conflictCount in the popover while sync appears active.
  test('state is "conflict" (not "idle") when restarting mid-merge with tracked conflicts', async () => {
    const files = ['docs/a.md', 'docs/b.md'];
    await setupRealMergeConflict(files);

    writeFileSync(
      join(okDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: files.map((f) => ({ file: f, detectedAt: '2026-04-17T00:00:00.000Z' })),
      }),
      'utf-8',
    );
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        consecutiveFailures: 0,
        inflightConflicts: files,
      }),
      'utf-8',
    );

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      const status = engine.getStatus();
      // The invariant: conflictCount > 0 (and git agrees) ⟹ state === 'conflict'.
      expect(status.conflictCount).toBe(2);
      expect(status.state).toBe('conflict');
    } finally {
      await engine.destroy();
    }
  });

  // Regression: if the user resolved (or aborted) the merge externally via CLI
  // between server runs, conflicts.json is stale. On restart we must trust git
  // and clear the persisted conflicts — otherwise the conflict warning lingers
  // forever even though there's nothing to resolve.
  test('clears stale conflicts.json when MERGE_HEAD is gone (user resolved externally)', async () => {
    // Real repo + remote, no merge in progress
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);

    // Stale persisted state from a previous run; user resolved via CLI in between.
    writeFileSync(
      join(okDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: [{ file: 'test.md', detectedAt: '2026-04-17T00:00:00.000Z' }],
      }),
      'utf-8',
    );
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        consecutiveFailures: 0,
        inflightConflicts: ['test.md'],
      }),
      'utf-8',
    );

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      const status = engine.getStatus();
      expect(status.conflictCount).toBe(0);
      expect(status.state).not.toBe('conflict');
    } finally {
      await engine.destroy();
    }
  });

  // Partial external resolve: user fixed one file via CLI but left the other,
  // leaving the merge still in progress. On restart we should drop the resolved
  // file from the store but keep the still-unmerged one.
  test('reconciles partial external resolve against git unmerged index', async () => {
    const files = ['docs/a.md', 'docs/b.md'];
    await setupRealMergeConflict(files);

    // User resolved docs/a.md externally via `git checkout --theirs && git add`,
    // leaving docs/b.md still unmerged.
    const git = simpleGit(projectDir);
    await git.raw(['checkout', '--theirs', '--', 'docs/a.md']);
    await git.raw(['add', '--', 'docs/a.md']);

    writeFileSync(
      join(okDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: files.map((f) => ({ file: f, detectedAt: '2026-04-17T00:00:00.000Z' })),
      }),
      'utf-8',
    );
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        consecutiveFailures: 0,
        inflightConflicts: files,
      }),
      'utf-8',
    );

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      const status = engine.getStatus();
      expect(status.conflictCount).toBe(1);
      expect(status.state).toBe('conflict');
      const conflicts = engine.getConflicts().map((c) => c.file);
      expect(conflicts).toEqual(['docs/b.md']);
    } finally {
      await engine.destroy();
    }
  });

  // Complement of the restart test: resolving the last conflict must clear
  // the 'conflict' state. Together these pin the invariant from both sides.
  test('state transitions out of "conflict" once the last conflict is resolved', async () => {
    const conflictedFile = 'a.md';
    await setupRealMergeConflict([conflictedFile]);

    writeFileSync(
      join(okDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: [{ file: conflictedFile, detectedAt: '2026-04-17T00:00:00.000Z' }],
      }),
      'utf-8',
    );
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        consecutiveFailures: 0,
        inflightConflicts: [conflictedFile],
      }),
      'utf-8',
    );

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      expect(engine.getStatus().state).toBe('conflict');

      await engine.resolveConflict(conflictedFile, 'mine');
      const after = engine.getStatus();
      expect(after.conflictCount).toBe(0);
      expect(after.state).not.toBe('conflict');
    } finally {
      await engine.destroy();
    }
  });

  test('ignores state files with unknown version', async () => {
    const persisted = { version: 99, consecutiveFailures: 9999, inflightConflicts: [] };
    writeFileSync(statePath(), JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });

  test('tolerates missing state file gracefully', async () => {
    // No state file written — engine should start without error
    const engine = makeEngine({ syncEnabled: false });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });

  test('tolerates corrupt state file gracefully', async () => {
    writeFileSync(statePath(), 'not-json', 'utf-8');
    const engine = makeEngine({ syncEnabled: false });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });
});

// ─── ConflictStore admission is content-only ─────────────────────────────────
//
// Regression for two related bug shapes where non-content files (e.g.
// `.mcp.json`) ended up in the sidebar Conflicts section with no editor
// surface to resolve from.
//
// **Dominant case (modify/modify on `.mcp.json`).** The partition predicate
// used `!ContentFilter.isExcluded(path)` to decide "is this content?" — but
// `isExcluded` is the SIDEBAR/file-index predicate and ALSO admits asset-
// extension files (`.json`, `.png`, `.csv`, ...) when they sit next to an
// `.md` via the sibling-asset rule. So `.mcp.json` at a directory with a
// `.md` neighbor was classified as content on ANY conflict and added to
// ConflictStore. Fix: gate partition on `isSupportedDocFile(path) AND
// !isExcluded(path)` — content = "the editor can show this in the DiffView".
//
// **Edge case (modify/delete on `.mcp.json`).** Even after the dominant
// case is fixed and the file routes to the non-content auto-resolve loop,
// `git checkout --theirs` fails with "does not have their version" when the
// upstream side deleted the file. The escalation used to push the file into
// `contentConflicts` (mirroring the dominant bug). Fix: on ANY non-content
// auto-resolve failure, `git merge --abort`, set
// `pausedReason='non-content-merge-failure'` with a terminal-resolution
// hint in `this.pullError`, and return — ConflictStore stays empty.
//
// Both fixes together: ConflictStore is content-only by construction.

describe('SyncEngine ConflictStore admission (content-only)', () => {
  /**
   * Set up a real two-clone divergence with the supplied `remoteAction`
   * applied to `.mcp.json` on the upstream side:
   *   - `'modify'` — sister bumps `.mcp.json` to a different value (regular
   *     text conflict; `--theirs` would resolve cleanly if reached).
   *   - `'delete'` — sister deletes `.mcp.json` (modify/delete conflict;
   *     `--theirs` fails with "does not have their version").
   *
   * The project clone always modifies `.mcp.json` locally and commits, so
   * the dirt is on HEAD (clears `prepareForMerge`'s `diff-index --name-only
   * HEAD` pre-check). A `foo.md` is seeded at root so the project dir has
   * an `.md` neighbor — that's what makes the sibling-asset rule fire in
   * the real `ContentFilter` and why the dominant bug was reachable.
   */
  async function setupDivergence(remoteAction: 'modify' | 'delete'): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);
    await bare.raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, '.mcp.json'), '{"a":1}\n', 'utf-8');
    writeFileSync(join(sisterDir, 'foo.md'), 'base\n', 'utf-8');
    await sister.add('.');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

    // beforeEach pre-creates projectDir + .ok/local/. `git clone` refuses
    // a non-empty destination, so wipe and let clone recreate it, then
    // re-create okDir so ConflictStore can write conflicts.json.
    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    if (remoteAction === 'modify') {
      writeFileSync(join(sisterDir, '.mcp.json'), '{"a":99}\n', 'utf-8');
      await sister.add('.mcp.json');
      await sister.commit('modify mcp on remote');
    } else {
      await sister.rm('.mcp.json');
      await sister.commit('delete mcp on remote');
    }
    await sister.push('origin', 'main');

    writeFileSync(join(projectDir, '.mcp.json'), '{"a":2}\n', 'utf-8');
    await project.add('.mcp.json');
    await project.commit('modify mcp locally');
  }

  /**
   * `stubContentFilter` returns `isExcluded: () => false` for every path —
   * the dominant bug shape. This mirrors the real `ContentFilter`'s
   * behavior for `.mcp.json` at a directory containing any `.md` (the
   * sibling-asset rule admits asset-extension files in that case). Tests
   * that pre-excluded `.mcp.json` via a custom stub would have masked the
   * partition bug rather than exercising the fix.
   */
  function makeEngineForConflict() {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
    });
  }

  test('modify/modify on .mcp.json auto-resolves cleanly, no ConflictStore entry', async () => {
    await setupDivergence('modify');

    const engine = makeEngineForConflict();
    try {
      await engine.start();
      await engine.trigger('pull');

      const status = engine.getStatus();
      // Partition fix: `.mcp.json` (not .md/.mdx) takes the non-content
      // auto-resolve path. `git checkout --theirs` succeeds, the merge
      // commits, sync returns to idle — nothing in ConflictStore.
      expect(status.conflictCount).toBe(0);
      expect(status.state).toBe('idle');
      expect(status.pausedReason).toBeUndefined();

      const mergeHeadPath = join(projectDir, '.git', 'MERGE_HEAD');
      expect(existsSync(mergeHeadPath)).toBe(false);

      const conflictsJsonPath = join(okDir, 'conflicts.json');
      if (existsSync(conflictsJsonPath)) {
        const parsed = JSON.parse(readFileSync(conflictsJsonPath, 'utf-8')) as {
          conflicts?: Array<{ file: string }>;
        };
        expect(parsed.conflicts ?? []).toEqual([]);
      }
    } finally {
      await engine.destroy();
    }
  });

  test('modify/delete on .mcp.json aborts the merge and pauses without ConflictStore entry', async () => {
    await setupDivergence('delete');

    const engine = makeEngineForConflict();
    try {
      await engine.start();
      await engine.trigger('pull');

      const status = engine.getStatus();
      // Partition routes `.mcp.json` to non-content auto-resolve;
      // `--theirs` fails because theirs has no version; the abort path
      // pauses sync with the new pausedReason.
      expect(status.conflictCount).toBe(0);
      expect(status.state).toBe('idle');
      expect(status.pausedReason).toBe('non-content-merge-failure');
      expect(status.pullError ?? '').toContain('.mcp.json');
      // Hint lists both common resolutions as equal alternatives — pinning
      // both keeps either order valid but rejects a regression that drops
      // one (e.g. `git rm` falling out, leaving only the `--theirs` form
      // that fails with "does not have their version" on this path).
      expect(status.pullError ?? '').toContain('git rm <file>');
      expect(status.pullError ?? '').toContain('git checkout');

      const mergeHeadPath = join(projectDir, '.git', 'MERGE_HEAD');
      expect(existsSync(mergeHeadPath)).toBe(false);

      const conflictsJsonPath = join(okDir, 'conflicts.json');
      if (existsSync(conflictsJsonPath)) {
        const parsed = JSON.parse(readFileSync(conflictsJsonPath, 'utf-8')) as {
          conflicts?: Array<{ file: string }>;
        };
        expect(parsed.conflicts ?? []).toEqual([]);
      }
    } finally {
      await engine.destroy();
    }
  });

  test('trigger() clears non-content-merge-failure pausedReason so retry can re-attempt', async () => {
    await setupDivergence('delete');

    const engine = makeEngineForConflict();
    try {
      await engine.start();
      await engine.trigger('pull');
      expect(engine.getStatus().pausedReason).toBe('non-content-merge-failure');

      const projectGit = simpleGit(projectDir);
      await projectGit.rm('.mcp.json');
      await projectGit.commit('resolve modify/delete locally');

      await engine.trigger('pull');
      const status = engine.getStatus();
      expect(status.pausedReason).toBeUndefined();
      expect(status.conflictCount).toBe(0);
      expect(status.state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Delete-vs-modify conflict from dirty working tree ───────────────────────

describe('SyncEngine delete/modify dirty content conflicts', () => {
  async function setupRemoteModifyLocalDelete(): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, 'foo.md'), 'base\n', 'utf-8');
    await sister.add('foo.md');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push(['--set-upstream', 'origin', 'main']);
    await bare.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    // beforeEach pre-creates projectDir + .ok/local/. `git clone` refuses
    // a non-empty destination, so wipe and let clone recreate it.
    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir, ['--branch', 'main']);
    mkdirSync(okDir, { recursive: true });

    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    writeFileSync(join(sisterDir, 'foo.md'), 'remote edit\n', 'utf-8');
    await sister.add('foo.md');
    await sister.commit('remote modify');
    await sister.push('origin', 'main');

    rmSync(join(projectDir, 'foo.md'), { force: true });
  }

  async function setupRemoteDeleteLocalModify(): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, 'foo.md'), 'base\n', 'utf-8');
    await sister.add('foo.md');
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push(['--set-upstream', 'origin', 'main']);
    await bare.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir, ['--branch', 'main']);
    mkdirSync(okDir, { recursive: true });

    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    await sister.rm('foo.md');
    await sister.commit('remote delete');
    await sister.push('origin', 'main');

    writeFileSync(join(projectDir, 'foo.md'), 'local edit\n', 'utf-8');
  }

  function makeProjectRootEngine(
    opts: { onContentConflictsDetected?: (files: string[]) => void | Promise<void> } = {},
  ) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      pullIntervalSeconds: 99999,
      pushIntervalSeconds: 99999,
      onContentConflictsDetected: opts.onContentConflictsDetected,
    });
  }

  test('surfaces a conflict when remote modifies a file deleted locally', async () => {
    await setupRemoteModifyLocalDelete();

    const engine = makeProjectRootEngine();
    try {
      await engine.start();
      await engine.trigger('sync');

      const status = engine.getStatus();
      expect(status.state).toBe('conflict');
      expect(status.conflictCount).toBe(1);
      expect(status.pausedReason).toBeUndefined();
      expect(engine.getConflicts().map((c) => c.file)).toEqual(['foo.md']);
      expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(true);

      const project = simpleGit(projectDir);
      const unmerged = (await project.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
      expect(unmerged).toBe('foo.md');

      const log = await project.raw(['log', '--oneline', '--max-count=5']);
      expect(log).not.toContain('Auto-save: interim before merge');
    } finally {
      await engine.destroy();
    }
  });

  test('notifies loaded-doc callback when remote deletes a file modified locally', async () => {
    await setupRemoteDeleteLocalModify();

    const notified: string[][] = [];
    const engine = makeProjectRootEngine({
      onContentConflictsDetected: (files) => {
        notified.push([...files]);
      },
    });
    try {
      await engine.start();
      await engine.trigger('sync');

      const status = engine.getStatus();
      expect(status.state).toBe('conflict');
      expect(status.conflictCount).toBe(1);
      expect(engine.getConflicts().map((c) => c.file)).toEqual(['foo.md']);
      expect(notified).toEqual([['foo.md']]);

      const project = simpleGit(projectDir);
      const unmerged = (await project.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
      expect(unmerged).toBe('foo.md');
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine non-ASCII filename conflicts', () => {
  const fileName = 'hyvää yötä.md';

  async function setupRemoteModifyLocalDeleteNonAscii(): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);

    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, fileName), 'base\n', 'utf-8');
    await sister.add([fileName]);
    await sister.commit('base');
    await sister.addRemote('origin', bareDir);
    await sister.push(['--set-upstream', 'origin', 'main']);
    await bare.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir, ['--branch', 'main']);
    mkdirSync(okDir, { recursive: true });

    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Project');
    await project.raw('config', 'user.email', 'project@test.com');

    writeFileSync(join(sisterDir, fileName), 'remote edit\n', 'utf-8');
    await sister.add([fileName]);
    await sister.commit('remote modify');
    await sister.push('origin', 'main');

    rmSync(join(projectDir, fileName), { force: true });
  }

  test('surfaces a content conflict with the real UTF-8 path', async () => {
    await setupRemoteModifyLocalDeleteNonAscii();

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      pullIntervalSeconds: 99999,
      pushIntervalSeconds: 99999,
    });
    try {
      await engine.start();
      await engine.trigger('sync');

      const status = engine.getStatus();
      expect(status.state).toBe('conflict');
      expect(status.conflictCount).toBe(1);
      expect(status.pausedReason).toBeUndefined();
      expect(engine.getConflicts().map((c) => c.file)).toEqual([fileName]);
      expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(true);
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Status shape ─────────────────────────────────────────────────────────────

describe('SyncEngine getStatus()', () => {
  test('returns all required fields in dormant state', () => {
    const engine = makeEngine();
    const status = engine.getStatus();
    expect(status).toHaveProperty('state', 'dormant');
    expect(status).toHaveProperty('lastSyncUtc', null);
    expect(status).toHaveProperty('lastFetchUtc', null);
    expect(status).toHaveProperty('lastPushedSha', null);
    expect(status).toHaveProperty('ahead', 0);
    expect(status).toHaveProperty('behind', 0);
    expect(status).toHaveProperty('consecutiveFailures', 0);
    expect(status).toHaveProperty('conflictCount', 0);
    expect(status).toHaveProperty('hasRemote', false);
  });
});

// ─── No-remote detection ──────────────────────────────────────────────────────

describe('SyncEngine no-remote detection', () => {
  test('stays dormant if project dir has no git remote (no .git/)', async () => {
    // projectDir has no git repo — git remote -v will fail or return empty
    const engine = makeEngine();
    await engine.start();
    // Without a git remote, engine should remain dormant
    expect(engine.getStatus().state).toBe('dormant');
    expect(engine.getStatus().hasRemote).toBe(false);
  });
});

// ─── refreshRemote() — lazy post-boot detection (staleness fix)
//
// `start()` snapshots `hasRemote` once at boot. If the user runs
// `git remote add origin <url>` afterwards, the Settings → Sync empty state
// (and the SyncStatusBadge) keep showing "no remote" until app restart.
// `refreshRemote()` re-runs `git remote -v` cheaply when nothing was detected
// at boot, transitions state appropriately, and broadcasts via transitionTo.

describe('SyncEngine refreshRemote()', () => {
  test('is a no-op when hasRemote is already true', async () => {
    // Set up a real repo with a remote so start() finds it.
    const git = simpleGit(projectDir);
    await git.init();
    await git.addRemote('origin', 'https://example.invalid/repo.git');

    const states: SyncState[] = [];
    const engine = makeEngine({ syncEnabled: false, onStateChange: (s) => states.push(s) });
    await engine.start();
    // start() already detected the remote → disabled (sync off, remote present)
    expect(engine.getStatus().hasRemote).toBe(true);
    expect(engine.getStatus().state).toBe('disabled');

    const callsBefore = states.length;
    await engine.refreshRemote();
    // No state churn from refreshRemote when remote was already known.
    expect(states.length).toBe(callsBefore);
    expect(engine.getStatus().hasRemote).toBe(true);
  });

  test('detects a newly-added remote and transitions dormant → disabled (syncEnabled=false)', async () => {
    const git = simpleGit(projectDir);
    await git.init();

    const states: SyncState[] = [];
    const engine = makeEngine({ syncEnabled: false, onStateChange: (s) => states.push(s) });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(false);
    expect(engine.getStatus().state).toBe('dormant');

    // User runs `git remote add origin <url>` externally.
    await git.addRemote('origin', 'https://example.invalid/repo.git');

    await engine.refreshRemote();

    expect(engine.getStatus().hasRemote).toBe(true);
    // syncEnabled=false: remote present but sync off → 'disabled'
    expect(engine.getStatus().state).toBe('disabled');
    expect(states).toContain('disabled');
  });

  test('detects a newly-added remote and transitions dormant → idle (syncEnabled=true)', async () => {
    const git = simpleGit(projectDir);
    await git.init();

    const states: SyncState[] = [];
    const engine = makeEngine({ syncEnabled: true, onStateChange: (s) => states.push(s) });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(false);
    expect(engine.getStatus().state).toBe('dormant');

    await git.addRemote('origin', 'https://example.invalid/repo.git');

    await engine.refreshRemote();

    expect(engine.getStatus().hasRemote).toBe(true);
    // syncEnabled=true: remote present and sync on → idle (timers scheduled)
    expect(engine.getStatus().state).toBe('idle');
    // onStateChange firing is the CC1 broadcast hook — pin it so a regression that bypasses
    // transitionTo (e.g. directly mutating this.state) still fails this test.
    expect(states).toContain('idle');

    // Stop timers so the test doesn't leak a real pull cycle against an invalid host.
    engine.stop();
  });

  test('stays dormant when no remote was added since boot', async () => {
    const git = simpleGit(projectDir);
    await git.init();

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(false);

    await engine.refreshRemote();

    expect(engine.getStatus().hasRemote).toBe(false);
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('tolerates missing .git/ without throwing', async () => {
    // projectDir has no .git/ at all — git remote -v fails.
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    await expect(engine.refreshRemote()).resolves.toBeUndefined();
    expect(engine.getStatus().hasRemote).toBe(false);
  });
});

// ─── setEnabled() — load-bearing unconditional probe ─────────────────────────
//
// setEnabled(true) shares `probeRemote()` with refreshRemote(), but invokes it
// UNCONDITIONALLY (no `if (this.hasRemote) return` short-circuit). That covers
// the case where a remote existed at boot but was removed externally before
// the user toggled sync back on — refreshRemote() would no-op (hasRemote still
// stale-true), and idle scheduling would race against a now-absent remote.

describe('SyncEngine setEnabled() — unconditional remote re-probe', () => {
  test('setEnabled(true) demotes to dormant when remote was removed since boot', async () => {
    const git = simpleGit(projectDir);
    await git.init();
    await git.addRemote('origin', 'https://example.invalid/repo.git');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(true);
    expect(engine.getStatus().state).toBe('disabled');

    // Externally remove the remote AFTER boot.
    await git.removeRemote('origin');

    await engine.setEnabled(true);

    expect(engine.getStatus().hasRemote).toBe(false);
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('setEnabled(true) transitions dormant → idle when remote was added since boot', async () => {
    const git = simpleGit(projectDir);
    await git.init();

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(false);
    expect(engine.getStatus().state).toBe('dormant');

    await git.addRemote('origin', 'https://example.invalid/repo.git');

    await engine.setEnabled(true);

    expect(engine.getStatus().hasRemote).toBe(true);
    expect(engine.getStatus().state).toBe('idle');

    engine.stop();
  });
});

// ─── updateCurrentBranch ──────────────────────────────────────────────────────

describe('SyncEngine updateCurrentBranch()', () => {
  test('transitions to disabled when branch is null (detached HEAD)', () => {
    const states: SyncState[] = [];
    // Manually set state to idle so the transition fires
    // We can't reach idle without a remote, so we check the guard condition
    // by reading the method directly on a fresh dormant engine.
    // Since engine is dormant, transition to disabled is skipped (guard: !== dormant).
    const engine = makeEngine({ onStateChange: (s) => states.push(s) });
    engine.updateCurrentBranch(null); // no-op when dormant
    expect(engine.getStatus().state).toBe('dormant');
    expect(states).toEqual([]);
  });
});

// ─── Backoff / consecutive failure thresholds ────────────────────────────────

describe('SyncEngine backoff thresholds via persisted state', () => {
  const statePath = () => join(okDir, 'sync-state.json');

  function persistState(overrides: Record<string, unknown>) {
    const base = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 0,
      inflightConflicts: [],
    };
    writeFileSync(statePath(), JSON.stringify({ ...base, ...overrides }), 'utf-8');
  }

  test('consecutiveFailures=0 is restored and stays in default interval range', async () => {
    persistState({ consecutiveFailures: 0 });
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });

  test('consecutiveFailures=3 is restored (5 min backoff threshold)', async () => {
    persistState({ consecutiveFailures: 3 });
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(3);
  });

  test('consecutiveFailures=5 is restored (15 min backoff threshold)', async () => {
    persistState({ consecutiveFailures: 5 });
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(5);
  });

  test('consecutiveFailures=8 is restored (60 min backoff threshold)', async () => {
    persistState({ consecutiveFailures: 8 });
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(8);
  });

  test('trigger() resets consecutiveFailures to 0', async () => {
    persistState({ consecutiveFailures: 5 });
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().consecutiveFailures).toBe(5);
    // trigger() resets consecutiveFailures even when dormant
    await engine.trigger();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });
});

// ─── Lifecycle edge cases ───────────────────────────────────────────────────

describe('SyncEngine lifecycle edge cases', () => {
  test('double start() is idempotent (second call is no-op)', async () => {
    const states: SyncState[] = [];
    const engine = makeEngine({ syncEnabled: false, onStateChange: (s) => states.push(s) });
    await engine.start();
    await engine.start(); // second start — should not throw or duplicate transitions
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('stop() after destroy() is idempotent', async () => {
    const engine = makeEngine();
    await engine.destroy();
    engine.stop(); // should not throw
    expect(engine.getStatus().state).toBe('dormant');
  });

  test('destroy() calls saveStateNow() and writes file', async () => {
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    await engine.destroy();
    expect(existsSync(join(okDir, 'sync-state.json'))).toBe(true);
  });

  test('pausedReason is persisted through destroy + restore', async () => {
    const statePath = join(okDir, 'sync-state.json');
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 0,
      pausedReason: 'detached-head',
      inflightConflicts: [],
    };
    writeFileSync(statePath, JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().pausedReason).toBe('detached-head');
  });

  test('loadState drops no-push-permission from legacy state files (defense-in-depth)', async () => {
    // `saveStateNow` filters this reason out of every fresh write, but a
    // state file written by an earlier build (or hand-edited) could still
    // carry it. `loadState` must drop it on read so the probe-on-start is
    // the single source of truth — otherwise users who gained collaborator
    // access mid-restart would still see "no push permission" until the
    // probe re-runs.
    const statePath = join(okDir, 'sync-state.json');
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 0,
      pausedReason: 'no-push-permission',
      inflightConflicts: [],
    };
    writeFileSync(statePath, JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().pausedReason).toBeUndefined();
  });

  test('saveStateNow does not persist no-push-permission when set in-memory by the probe', async () => {
    // Genuine pin for the `saveStateNow` filter — the engine must have
    // `pausedReason='no-push-permission'` IN MEMORY when destroy() runs,
    // so the filter is exercised on its way to disk. The earlier draft
    // pre-seeded the state file, which made `loadState` strip the reason
    // BEFORE saveStateNow ran — the filter was never reached and a
    // future refactor that removed it would have left the test green.
    //
    // Sequence: probe returns denied → engine sets pausedReason in
    // memory → destroy → saveStateNow → state file must NOT carry the
    // reason.
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().pausedReason).toBe('no-push-permission');

    await engine.destroy(); // saveStateNow flushes the in-memory pausedReason

    const statePath = join(okDir, 'sync-state.json');
    const reloaded = JSON.parse(readFileSync(statePath, 'utf-8')) as { pausedReason?: string };
    expect(reloaded.pausedReason).toBeUndefined();
  });
});

// ─── Push cycle: ahead-of-origin without new commits ───────────────────────

describe('SyncEngine push cycle pushes existing commits when local is ahead of origin', () => {
  // Regression: after conflict resolution finalizes a merge with `git commit
  // --no-edit`, the working tree matches the new HEAD. The push cycle's
  // "tree unchanged" early-exit used to short-circuit before `git push`,
  // leaving the merge commit unpushed forever.
  test('pushes existing HEAD when local is ahead of origin and tree is clean', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);

    // Simulate the post-conflict-resolution state: a local commit that
    // hasn't been pushed yet, and a clean working tree (commit-finalized
    // merge, or any prior unpushed commit).
    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nlocal change\n');
    await git.add('.');
    await git.commit('local commit not yet pushed');

    const headBefore = (await git.revparse(['HEAD'])).trim();
    const remoteBefore = (await git.revparse(['origin/main'])).trim();
    expect(headBefore).not.toBe(remoteBefore);

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      await engine.trigger('push');

      const remoteAfter = (await git.revparse(['origin/main'])).trim();
      expect(remoteAfter).toBe(headBefore);
      expect(engine.getStatus().lastPushedSha).toBe(headBefore);
    } finally {
      await engine.destroy();
    }
  });

  test('records lastSyncUtc when HEAD already matches origin and tree is clean', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);

    const head = (await git.revparse(['HEAD'])).trim();
    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.lastPushedSha).toBe(head);
      expect(status.lastSyncUtc).not.toBeNull();
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine push cycle with non-ASCII filenames', () => {
  const fileName = 'hyvää yötä.md';

  test('commits and pushes the deletion of a file with a non-ASCII name', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    writeFileSync(join(projectDir, fileName), 'sisältö\n');
    await git.add('.');
    await git.commit('add non-ascii file');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);

    rmSync(join(projectDir, fileName));

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.trigger('push');

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('README.md');
      expect(headPaths).not.toContain(fileName);

      const subject = (await git.raw(['log', '--format=%s', '--max-count=1'])).trim();
      expect(subject).toContain(fileName);

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine per-operation error isolation', () => {
  // Regression: a single shared error field let a successful fetch clear a
  // failed push's error, so the sync popover flashed the push error for a
  // split second before the pull leg (manual `sync`, or any background pull)
  // wiped it. Push and pull errors are now tracked separately. Repro shape is
  // a read-allowed / write-denied remote — a public repo, or here a valid
  // fetch URL plus a bogus `remote.origin.pushurl` so push fails while fetch
  // succeeds in the same `trigger('sync')` (push-then-pull).
  test('a successful fetch does not clear a standing push error', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);

    // Read-allowed / write-denied: fetch resolves the real bare remote; push
    // targets a path that does not exist, so `git push` fails deterministically
    // while `git fetch` keeps succeeding.
    await git.raw('config', 'remote.origin.pushurl', join(tmpDir, 'nonexistent-bare.git'));

    // A local commit gives the push cycle something to push (ahead by one).
    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nlocal change\n');
    await git.add('.');
    await git.commit('local commit');

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      // One "Sync now": push (fails on the bogus pushurl) then pull (fetch
      // from the real bare remote succeeds).
      await engine.trigger('sync');

      const status = engine.getStatus();
      // The push genuinely failed and its error is recorded...
      expect(status.pushError ?? '').not.toBe('');
      // ...the fetch genuinely succeeded (lastFetchUtc advanced)...
      expect(status.lastFetchUtc).not.toBeNull();
      // ...and that success did NOT wipe the push error. Pre-fix, the shared
      // error field was cleared by fetch success, leaving it undefined here.
      expect(status.pullError).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });

  // The mirror of the above: the same shared-field bug let a successful push
  // clear a standing pull error. Repro is the inverse remote shape — a valid
  // pushurl plus a bogus fetch `url`, so `git fetch` fails (pull error stands)
  // while a later `git push` succeeds. Two triggers because `sync` runs
  // push-then-pull; to prove the pull error survives a push *success* the push
  // must come after the failure, so we drive the legs explicitly.
  test('a successful push does not clear a standing pull error', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    // Establish the upstream ref against the real bare while `url` still points
    // at it, then break fetch by repointing `url` and routing push via pushurl.
    await git.push(['--set-upstream', 'origin', 'main']);
    await git.raw('config', 'remote.origin.url', join(tmpDir, 'nonexistent-bare.git'));
    await git.raw('config', 'remote.origin.pushurl', bareDir);

    // A local commit gives the push cycle something to push (ahead by one).
    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nlocal change\n');
    await git.add('.');
    await git.commit('local commit');
    const head = (await git.revparse(['HEAD'])).trim();

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();

      // Pull leg first: fetch from the bogus `url` fails, recording a pull error.
      await engine.trigger('pull');
      const afterPull = engine.getStatus();
      expect(afterPull.pullError ?? '').not.toBe('');
      expect(afterPull.pushError).toBeUndefined();

      // Push leg: succeeds via the valid pushurl...
      await engine.trigger('push');
      const afterPush = engine.getStatus();
      const remoteAfter = (await simpleGit(bareDir).revparse(['main'])).trim();
      expect(remoteAfter).toBe(head);
      expect(afterPush.lastPushedSha).toBe(head);
      // ...and that success did NOT wipe the standing pull error. Pre-fix, the
      // shared error field was cleared by push success, leaving it undefined.
      expect(afterPush.pullError ?? '').not.toBe('');
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Status shape completeness ──────────────────────────────────────────────

describe('SyncEngine push-permission probe', () => {
  test('does NOT run when there is no remote', async () => {
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    expect(probe.calls).toBe(0);
    expect(engine.getStatus().pushPermission).toBeUndefined();
  });

  test('does NOT run for a non-github origin (gitlab, self-hosted) — emits unknown', async () => {
    // Non-github origin: the GitHub-only probe can't run, but we MUST NOT
    // leave `pushPermission` undefined — the AutoSync onboarding gate
    // requires the field to be present (`'allowed' | 'unknown'`) before
    // it shows the dialog. Without the unknown emission, GitLab /
    // Bitbucket / self-hosted users would be permanently blocked from
    // onboarding.
    await initGitWithOrigin('https://gitlab.com/foo/bar.git');
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.calls).toBe(0);
    expect(engine.getStatus().pushPermission).toEqual({ checkStatus: 'unknown' });
  });

  test('records `allowed` after start() against a github origin', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(probe.calls).toBe(1);
    expect(engine.getStatus().pushPermission).toEqual({
      checkStatus: 'allowed',
    });
  });

  test('records `denied` and pauses in-memory when syncEnabled is true', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const status = engine.getStatus();
    expect(probe.calls).toBe(1);
    expect(status.pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'no-collaborator',
    });
    expect(status.state).toBe('disabled');
    expect(status.pausedReason).toBe('no-push-permission');
  });

  test('records `denied` but does NOT change state when syncEnabled is false', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const status = engine.getStatus();
    expect(status.pushPermission?.checkStatus).toBe('denied');
    // syncEnabled=false started the engine in 'disabled' regardless. The
    // pausedReason must NOT be 'no-push-permission' since the engine wasn't
    // running — it's just reporting the probe result.
    expect(status.pausedReason).not.toBe('no-push-permission');
  });

  test('maps private-no-access denial through to status', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'private-no-access' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'private-no-access',
    });
  });

  test('maps repo-not-found denial through to status', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'repo-not-found' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().pushPermission).toEqual({
      checkStatus: 'denied',
      deniedReason: 'repo-not-found',
    });
  });

  test('does NOT write autoSync.enabled = false to __local__/project on denied (D6 in-memory invariant)', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    // The engine took the in-memory pause path; it must NOT have written
    // any persistent config under .ok/local that would survive restart.
    // Inspect the local dir for any new config-shaped files that could
    // have been mutated. The probe-pause path uses pausedReason only.
    const persisted =
      existsSync(join(okDir, 'config.yml')) || existsSync(join(okDir, 'config.json'));
    expect(persisted).toBe(false);
  });

  test('records `unknown` without changing state', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'unknown', error: 'network' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const status = engine.getStatus();
    expect(status.pushPermission).toEqual({
      checkStatus: 'unknown',
      unknownError: 'network',
    });
    // Engine still goes to 'idle' (syncEnabled=true) because unknown is
    // never treated as a hard signal to pause.
    expect(status.state).toBe('idle');
    expect(status.pausedReason).not.toBe('no-push-permission');
  });

  test('refreshPushPermission re-runs the probe and updates status', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'unknown', error: 'network' }, { kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().pushPermission?.checkStatus).toBe('unknown');

    const next = await engine.refreshPushPermission();
    expect(next).toEqual({ checkStatus: 'allowed' });
    expect(engine.getStatus().pushPermission?.checkStatus).toBe('allowed');
    expect(probe.calls).toBe(2);
  });

  test('refreshPushPermission resumes idle when a previously-denied user gets push access', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' }, { kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().state).toBe('disabled');
    expect(engine.getStatus().pausedReason).toBe('no-push-permission');

    await engine.refreshPushPermission();
    const status = engine.getStatus();
    expect(status.pushPermission?.checkStatus).toBe('allowed');
    expect(status.state).toBe('idle');
    expect(status.pausedReason).toBeUndefined();
  });

  test('refreshPushPermission emits unknown for non-github origin (does not call probe)', async () => {
    // Non-github origins can't run the GitHub-only probe, but they must
    // still surface `{ checkStatus: 'unknown' }` so the AutoSync onboarding
    // gate (which requires pushPermission to be set) doesn't permanently
    // hide the dialog for GitLab / Bitbucket / self-hosted users.
    await initGitWithOrigin('https://gitlab.com/foo/bar.git');
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    const result = await engine.refreshPushPermission();
    expect(result).toEqual({ checkStatus: 'unknown' });
    expect(probe.calls).toBe(0);
  });

  test('handles a probe that throws (defense-in-depth)', async () => {
    await initGitWithOrigin();
    const throwingProbe: FakeProbeRecorder['fn'] = async () => {
      throw new Error('injected fake failure');
    };
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: throwingProbe });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    // engine should record unknown/network on injected throw; never propagate.
    expect(engine.getStatus().pushPermission).toEqual({
      checkStatus: 'unknown',
      unknownError: 'network',
    });
  });

  test('pushPermission is omitted from status before the probe resolves', () => {
    // No start() at all — engine is dormant; pushPermission has never been
    // touched. Verifies the absent-field invariant.
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    expect(engine.getStatus().pushPermission).toBeUndefined();
  });

  // ─── invariant: read+write user parity ───────────────────────
  // The push-permission feature must produce zero observable change for users
  // whose probe ultimately resolves `allowed`. The five tests below cover the
  // states an `allowed`-historical user can land in across a session:
  //   (i)   probe-pending — probe in flight on cold start
  //   (ii)  probe-allowed — terminal happy path
  //   (iii) probe-unknown / network-fail — probe never resolves; engine
  //         carries on with current behavior
  //   (iv)  status payload never contains an `'allowed'` pushPermission while
  //         the probe is in flight (no leaky transient state)
  //   (v)   transitioning from idle → fetching during the probe window does
  //         not produce a 'no-push-permission' pausedReason

  test('FR7: pushPermission is absent during the probe window (cold-start latency)', async () => {
    await initGitWithOrigin();
    // Inject a probe that resolves slowly so we can observe the window.
    let resolveProbe: (p: import('./github-permissions.ts').PushPermission) => void = () => {};
    const slowProbe: FakeProbeRecorder['fn'] = () =>
      new Promise((res) => {
        resolveProbe = res;
      });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: slowProbe });
    await engine.start();
    // start() returned; the probe is still pending. The status payload
    // MUST omit pushPermission so allowed-historical UI consumers render
    // current behavior. This is the failure mode that would otherwise
    // flicker the AutoSyncOnboardingDialog for an `allowed` user.
    expect(engine.getStatus().pushPermission).toBeUndefined();
    // Resolve the probe; pushPermission appears.
    resolveProbe({ kind: 'allowed' });
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().pushPermission?.checkStatus).toBe('allowed');
  });

  test('FR7: `unknown` (network failure) preserves the absent-or-allowed UI invariant', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'unknown', error: 'network' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const status = engine.getStatus();
    // Engine recorded the unknown outcome for diagnostics, but the UI
    // gate keys off `pushPermission.checkStatus === 'denied'` (per
    // shouldDisableSyncSwitch + EditorPane mount-gate clause). Neither
    // 'unknown' nor undefined triggers gating — Switch stays enabled,
    // dialog renders per existing condition.
    expect(status.pushPermission?.checkStatus).toBe('unknown');
    expect(status.pushPermission?.checkStatus).not.toBe('denied');
  });

  test('FR7: transitioning idle → fetching during probe window does NOT set no-push-permission pausedReason', async () => {
    await initGitWithOrigin();
    // Slow probe again so the engine reaches 'idle' before pushPermission resolves.
    let resolveProbe: (p: import('./github-permissions.ts').PushPermission) => void = () => {};
    const slowProbe: FakeProbeRecorder['fn'] = () =>
      new Promise((res) => {
        resolveProbe = res;
      });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: slowProbe });
    await engine.start();
    // syncEnabled=true + hasRemote=true → engine reaches 'idle' before probe.
    expect(engine.getStatus().state).toBe('idle');
    expect(engine.getStatus().pausedReason).not.toBe('no-push-permission');
    // Probe resolves allowed; engine stays idle.
    resolveProbe({ kind: 'allowed' });
    await waitForPushPermissionResolved(engine);
    expect(engine.getStatus().state).toBe('idle');
    expect(engine.getStatus().pausedReason).toBeUndefined();
  });
});

describe('SyncEngine getStatus() with restored state', () => {
  const statePath = () => join(okDir, 'sync-state.json');

  test('lastSyncUtc and lastFetchUtc are restored', async () => {
    const now = new Date().toISOString();
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: now,
        lastFetchUtc: now,
        lastPushedSha: 'abc123',
        consecutiveFailures: 0,
        inflightConflicts: [],
      }),
      'utf-8',
    );

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    const status = engine.getStatus();
    expect(status.lastSyncUtc).toBe(now);
    expect(status.lastFetchUtc).toBe(now);
    expect(status.lastPushedSha).toBe('abc123');
  });
});

// ─── Auth-error recovery ────────────────────────────────────────────────────

interface InternalState {
  state: SyncState;
  pausedReason?: string;
  pushError?: string;
  pullError?: string;
  pushErrorCode?: string;
  pullErrorCode?: string;
  gitHandle: () => unknown;
  handleError: (classified: ReturnType<typeof classifyGitError>, op: 'push' | 'pull') => void;
}

describe('SyncEngine auth-error recovery', () => {
  const statePath = () => join(okDir, 'sync-state.json');

  test('does not restore a persisted auth-error pausedReason (re-attempts on restart)', async () => {
    // A prior build (or hand edit) could leave auth-error on disk. It must not
    // survive restart, or a relaunch after the user reconnected stays stuck.
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        consecutiveFailures: 0,
        inflightConflicts: [],
        pausedReason: 'auth-error',
      }),
      'utf-8',
    );
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().pausedReason).toBeUndefined();
  });

  test('saveStateNow does not persist auth-error when set in-memory', async () => {
    // Pin the SAVE-side filter: the engine must carry `pausedReason='auth-error'`
    // IN MEMORY when destroy() flushes state to disk, so the filter is exercised
    // on its way out. Pre-seeding the file would let loadState strip the reason
    // before saveStateNow ran, leaving the test green even if the filter were
    // removed.
    const engine = makeEngine({ syncEnabled: true });
    const internal = engine as unknown as InternalState;
    internal.state = 'auth-error';
    internal.pausedReason = 'auth-error';

    await engine.destroy(); // saveStateNow flushes the in-memory pausedReason

    const reloaded = JSON.parse(readFileSync(statePath(), 'utf-8')) as { pausedReason?: string };
    expect(reloaded.pausedReason).toBeUndefined();
  });

  test('notifyCredentialsChanged clears auth-error and re-evaluates', async () => {
    const engine = makeEngine({ syncEnabled: true });
    // Force the parked state the sync cycle sets on a credential failure,
    // including the error text/codes that drove the red UI — recovery must
    // clear them too, or the badge shows stale errors alongside an idle state.
    const internal = engine as unknown as InternalState;
    internal.state = 'auth-error';
    internal.pausedReason = 'auth-error';
    internal.pushError = 'no credential';
    internal.pullError = 'no credential';
    internal.pushErrorCode = 'auth-no-credential';
    internal.pullErrorCode = 'auth-no-credential';
    expect(engine.getStatus().state).toBe('auth-error');

    await engine.notifyCredentialsChanged();

    const status = engine.getStatus();
    expect(status.state).not.toBe('auth-error');
    expect(status.pausedReason).toBeUndefined();
    expect(status.pushError).toBeUndefined();
    expect(status.pullError).toBeUndefined();
    expect(status.pushErrorCode).toBeUndefined();
    expect(status.pullErrorCode).toBeUndefined();
    // No remote in this fixture → re-evaluates to dormant (not stuck on auth).
    expect(status.state).toBe('dormant');
    await engine.destroy();
  });

  test('notifyCredentialsChanged is a no-op when sync is disabled', async () => {
    const engine = makeEngine({ syncEnabled: false });
    (engine as unknown as InternalState).pausedReason = 'auth-error';
    await engine.notifyCredentialsChanged();
    // A disabled engine does not resume on a credential change.
    expect(engine.getStatus().pausedReason).toBe('auth-error');
  });

  test('notifyCredentialsChanged is a no-op when not parked on auth-error', async () => {
    const engine = makeEngine({ syncEnabled: true });
    const before = engine.getStatus().state;
    await engine.notifyCredentialsChanged();
    expect(engine.getStatus().state).toBe(before);
  });
});

// ─── gh-token credential relay ────────────────────────────────────────────────

/** A `detectGh` recorder: counts calls and captures the host argument. */
function recordDetectGh(result: ReturnType<DetectGhFn>): {
  fn: DetectGhFn;
  calls: () => number;
  lastHost: () => string | undefined;
} {
  let calls = 0;
  let lastHost: string | undefined;
  return {
    fn: (host?: string) => {
      calls++;
      lastHost = host;
      return result;
    },
    calls: () => calls,
    lastHost: () => lastHost,
  };
}

describe('SyncEngine gh-token credential relay', () => {
  test('threads the resolved gh token through git handles during a real push cycle', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);

    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nchange\n');
    await git.add('.');
    await git.commit('local commit');

    const detect = recordDetectGh({ available: true, token: 'gho_relayed' });
    const engine = new SyncEngine({
      projectDir,
      contentDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      detectGh: detect.fn,
    });
    try {
      await engine.start();
      await engine.trigger('push');

      // The engine builds every git handle via `gitHandle()`, which resolves
      // the gh token host-scoped to github.com. A completed cycle proves the
      // resolver is consulted (so the token reaches the credential helper env).
      expect(detect.calls()).toBeGreaterThan(0);
      expect(detect.lastHost()).toBe('github.com');
    } finally {
      await engine.destroy();
    }
  });

  test('caches the gh token across handles, then re-resolves after an auth error', () => {
    const detect = recordDetectGh({ available: true, token: 'gho_relayed' });
    const engine = new SyncEngine({
      projectDir,
      contentDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      detectGh: detect.fn,
    });
    const internal = engine as unknown as InternalState;

    // Two handles within the TTL → a single detectGh spawn (cache hit).
    internal.gitHandle();
    internal.gitHandle();
    expect(detect.calls()).toBe(1);

    // An auth-class failure (the credential the cache holds may be the stale
    // one that just failed) drops the cache, so the next handle re-resolves.
    internal.handleError(
      classifyGitError(
        new Error(
          'fatal: could not read Username for https://github.com: terminal prompts disabled',
        ),
      ),
      'push',
    );
    internal.gitHandle();
    expect(detect.calls()).toBe(2);
  });
});
