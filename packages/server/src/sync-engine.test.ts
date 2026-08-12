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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// This suite runs in CI despite oven-sh/bun#11892 (Bun fails to kill/reap
// spawned child processes on GitHub Actions runners; still open upstream).
// Two facts make that safe here: the suite only spawns short-lived git
// children via simple-git — not the long-lived spawn+kill pattern from the
// bun issue — and the bare-remote fixtures pin their branch explicitly, so
// the suite passes under CI's `master`-default git
// (inkeep/open-knowledge#361). If this file ever flakes or hangs in CI,
// narrow to a targeted skip of the specific live-git describe blocks —
// do not restore a blanket process.env.CI gate.

import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_DIR, type SyncMode, SyncStatusSchema } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { createContentFilter } from './content-filter.ts';
import { classifyGitError } from './error-classification.ts';
import { listNames } from './git-paths.ts';
import type { DetectGhFn, ProbeTokenStore } from './github-permissions.ts';
import { getLogger } from './logger.ts';
import { classifyFastForwardRefusal, SyncEngine, type SyncState } from './sync-engine.ts';

const execFileAsync = promisify(execFile);

// ─── Minimal ContentFilter stub ───────────────────────────────────────────────

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

// Capture the engine's structured pino telemetry so a test can assert the
// bounded field shape of a log emitted by a real cycle. `getLogger` caches by
// name, so the spy intercepts the same instance the module captured at import.
interface CapturedLog {
  data: Record<string, unknown>;
  msg: string;
  level: 'info' | 'warn';
}
function captureSyncLogs(): { entries: CapturedLog[]; restore: () => void } {
  const entries: CapturedLog[] = [];
  const logger = getLogger('sync-engine');
  const record =
    (level: CapturedLog['level']) =>
    (data: unknown, msg?: string): void => {
      entries.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '', level });
    };
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(record('info') as never);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(record('warn') as never);
  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

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

function makeEngine(
  opts: { syncEnabled?: boolean; mode?: SyncMode; onStateChange?: (s: SyncState) => void } = {},
) {
  return new SyncEngine({
    projectDir,
    contentDir,
    contentFilter: stubContentFilter,
    syncEnabled: opts.syncEnabled,
    mode: opts.mode,
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
  opts: import('./github-permissions.ts').CheckPushPermissionOptions[];
  fn: (
    opts: import('./github-permissions.ts').CheckPushPermissionOptions,
  ) => Promise<import('./github-permissions.ts').PushPermission>;
}

function fakeProbe(...sequence: Array<import('./github-permissions.ts').PushPermission>) {
  const rec: FakeProbeRecorder = {
    calls: 0,
    next: [...sequence],
    opts: [],
    fn: async (opts) => {
      rec.calls++;
      rec.opts.push(opts);
      return rec.next.shift() ?? { kind: 'unknown', error: 'network' };
    },
  };
  return rec;
}

function makeProbeEngine(opts: {
  syncEnabled?: boolean;
  mode?: SyncMode;
  fakeProbe: FakeProbeRecorder['fn'];
}) {
  return new SyncEngine({
    projectDir,
    contentDir,
    contentFilter: stubContentFilter,
    syncEnabled: opts.syncEnabled,
    mode: opts.mode,
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

  test('a commit failure after auto-resolving a non-content conflict reports error, not success', async () => {
    await setupDivergence('modify');
    // A failing pre-commit hook rejects the merge-completion `git commit --no-edit`
    // after `.mcp.json` auto-resolves cleanly. simple-git does NOT throw on that
    // non-zero exit, so the engine must confirm the merge actually completed
    // (MERGE_HEAD cleared) rather than reporting a successful pull over a
    // half-merged tree.
    const hookPath = join(projectDir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    chmodSync(hookPath, 0o755);

    const engine = makeEngineForConflict();
    try {
      await engine.start();
      const outcome = await engine.pullOnce();

      // The commit was rejected and the merge aborted: the outcome must be the
      // error class (not 'succeeded'), pullError must surface it, and no
      // half-merged residue may remain.
      expect(outcome).toBe('error');
      const status = engine.getStatus();
      expect(status.lastPullOutcome).toBe('error');
      expect(status.pullError ?? '').not.toBe('');
      expect(status.state).toBe('idle');
      expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(false);
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

// ─── Auth-conditional pull cadence ──────────────────────────────────────────

describe('SyncEngine pull-only cadence (auth-conditional)', () => {
  // The scheduled pull delay carries ±15% jitter, so assert on the tier band
  // (base 30s vs the anonymous 180s floor) rather than an exact value.
  const AUTHENTICATED_BAND = { min: 30 * 0.85 * 1000, max: 30 * 1.15 * 1000 };
  const ANONYMOUS_BAND = { min: 180 * 0.85 * 1000, max: 180 * 1.15 * 1000 };

  type CadenceInternals = {
    refreshAuthTier(): Promise<void>;
    effectivePullDelayMs(): number;
  };

  function makeCadenceEngine(opts: {
    mode: SyncMode;
    detectGh?: DetectGhFn;
    tokenStore?: ProbeTokenStore | null;
  }) {
    return new SyncEngine({
      projectDir,
      contentDir,
      contentFilter: stubContentFilter,
      mode: opts.mode,
      pullIntervalSeconds: 30,
      pushIntervalSeconds: 99999,
      detectGh: opts.detectGh,
      tokenStore: opts.tokenStore,
    });
  }

  /** Resolve the auth tier, then read the delay the engine would schedule. */
  async function scheduledPullDelayMs(engine: SyncEngine): Promise<number> {
    const internals = engine as unknown as CadenceInternals;
    await internals.refreshAuthTier();
    return internals.effectivePullDelayMs();
  }

  test('an anonymous follower schedules pulls at the gentle cadence', async () => {
    const engine = makeCadenceEngine({ mode: 'follow' }); // no gh, no token store
    const delayMs = await scheduledPullDelayMs(engine);
    expect(delayMs).toBeGreaterThanOrEqual(ANONYMOUS_BAND.min);
    expect(delayMs).toBeLessThanOrEqual(ANONYMOUS_BAND.max);
  });

  test('a gh-authenticated follower keeps the responsive cadence', async () => {
    const engine = makeCadenceEngine({
      mode: 'follow',
      detectGh: () => ({ available: true, token: 'gh-token' }),
    });
    const delayMs = await scheduledPullDelayMs(engine);
    expect(delayMs).toBeGreaterThanOrEqual(AUTHENTICATED_BAND.min);
    expect(delayMs).toBeLessThanOrEqual(AUTHENTICATED_BAND.max);
  });

  test('a follower authenticated only through the token store keeps the responsive cadence', async () => {
    const engine = makeCadenceEngine({
      mode: 'follow',
      tokenStore: { get: async () => ({ token: 'store-token' }) },
    });
    const delayMs = await scheduledPullDelayMs(engine);
    expect(delayMs).toBeGreaterThanOrEqual(AUTHENTICATED_BAND.min);
    expect(delayMs).toBeLessThanOrEqual(AUTHENTICATED_BAND.max);
  });

  test('a token-store read failure degrades to the gentle cadence', async () => {
    const engine = makeCadenceEngine({
      mode: 'follow',
      tokenStore: {
        get: async () => {
          throw new Error('EACCES');
        },
      },
    });
    const delayMs = await scheduledPullDelayMs(engine);
    expect(delayMs).toBeGreaterThanOrEqual(ANONYMOUS_BAND.min);
    expect(delayMs).toBeLessThanOrEqual(ANONYMOUS_BAND.max);
  });

  test('full-sync cadence is untouched even with no credentials', async () => {
    // A credential-less full-sync engine must still schedule at the base
    // interval: the anonymous floor applies only to pull-only followers.
    const engine = makeCadenceEngine({ mode: 'full' });
    const delayMs = await scheduledPullDelayMs(engine);
    expect(delayMs).toBeGreaterThanOrEqual(AUTHENTICATED_BAND.min);
    expect(delayMs).toBeLessThanOrEqual(AUTHENTICATED_BAND.max);
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

describe('SyncEngine push cycle vs gitignored content (precedent #55 at the staging boundary)', () => {
  // Content admission is broader than git sync scope for managed artifacts:
  // the content filter admits `<folder>/.ok/templates/*.md` even when a
  // local-only-sharing project excludes `.ok/` via `.git/info/exclude`.
  // Naming such a path in `git add` fatals with `addIgnoredFile`, which used
  // to wedge every push cycle. The stub filter admits everything, standing in
  // for that carve-out.
  const templatePath = join('trips', '.ok', 'templates', 'article.md');
  const templateRel = 'trips/.ok/templates/article.md';

  async function initRepoWithBareRemote() {
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
    return git;
  }

  function makePushEngine() {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
    });
  }

  test('skips untracked ignored paths instead of failing the whole push cycle', async () => {
    const git = await initRepoWithBareRemote();
    writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');

    mkdirSync(join(projectDir, 'trips', '.ok', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, templatePath), '# Template\n');
    writeFileSync(join(projectDir, 'note.md'), 'new note\n');

    const engine = makePushEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.pushError).toBeUndefined();
      expect(status.consecutiveFailures).toBe(0);

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('note.md');
      expect(headPaths).not.toContain(templateRel);

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });

  test('keeps syncing edits to a tracked file that an ignore rule also matches', async () => {
    // git's ignore rules never apply to tracked files, so a template that was
    // committed while the project was in shared mode must keep syncing after a
    // switch to local-only. This also pins the deletion-set pairing: a filter
    // consulting an unseeded index would misread the file as untracked, skip
    // it, and commit its HEAD entry as a deletion.
    const git = await initRepoWithBareRemote();
    mkdirSync(join(projectDir, 'trips', '.ok', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, templatePath), '# Template v1\n');
    await git.add('.');
    await git.commit('add template while shared');
    await git.push(['origin', 'main']);

    writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
    writeFileSync(join(projectDir, templatePath), '# Template v2\n');

    const engine = makePushEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.pushError).toBeUndefined();

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain(templateRel);
      const blob = await git.raw(['show', `HEAD:${templateRel}`]);
      expect(blob).toBe('# Template v2\n');

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine push cycle stages shareable .ok artifacts (sync scope)', () => {
  // These tests run the real ContentFilter, not the permissive stub: the
  // behavior under test is the interplay between the filter's sync-scope
  // admission and the engine's staging + deletion-tracking paths, which the
  // admit-everything stub cannot express.

  async function initSharedRepoWithBareRemote() {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# Test\n');
    await git.add('.');
    await git.commit('Initial');

    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    const bare = simpleGit(bareDir);
    await bare.init(true);
    await bare.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);
    return { git, bareDir };
  }

  /** Call after all fixture file writes — the filter reads ignore sources at creation. */
  function makeShareableEngine(mode?: SyncMode) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: createContentFilter({ projectDir, contentDir: projectDir }),
      ...(mode ? { mode } : { syncEnabled: true }),
    });
  }

  async function cloneAsTeammate(bareDir: string) {
    const sisterDir = join(tmpDir, 'sister');
    await simpleGit(tmpDir).clone(bareDir, sisterDir);
    const sister = simpleGit(sisterDir);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    return { sister, sisterDir };
  }

  test('stages and pushes every shareable artifact class in a shared full-mode project', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
    mkdirSync(join(projectDir, '.ok', 'templates'), { recursive: true });
    mkdirSync(join(projectDir, 'docs', '.ok', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');
    writeFileSync(join(projectDir, '.ok', '.gitignore'), 'local/\nworktrees/\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
    writeFileSync(join(projectDir, '.ok', 'templates', 'meeting.md'), '# Meeting\n');
    writeFileSync(join(projectDir, 'docs', '.ok', 'templates', 'article.md'), '# Article\n');
    writeFileSync(join(projectDir, 'docs', '.ok', 'frontmatter.yml'), 'icon: book\n');
    writeFileSync(join(projectDir, 'docs', 'guide.md'), '# Guide\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.pushError).toBeUndefined();
      expect(status.consecutiveFailures).toBe(0);

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      for (const path of [
        '.ok/config.yml',
        '.ok/.gitignore',
        '.ok/schemas/frontmatter.json',
        '.ok/templates/meeting.md',
        'docs/.ok/templates/article.md',
        'docs/.ok/frontmatter.yml',
        'docs/guide.md',
      ]) {
        expect(headPaths).toContain(path);
      }

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });

  test('stages, updates, and deletes files in a doc-relative attachment folder without a sibling doc', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(join(projectDir, 'assets', 'diagram.png'), 'attachment-v1');

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: createContentFilter({
        projectDir,
        contentDir: projectDir,
        // `./assets` is the doc-relative shape: admission additionally
        // requires a document in the attachment folder's parent — satisfied
        // here by the fixture's root README.md. Fully doc-less admission is
        // the fixed-shape test below.
        attachmentFolderPath: './assets',
      }),
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.trigger('push');
      expect(await git.raw(['show', 'HEAD:assets/diagram.png'])).toBe('attachment-v1');

      writeFileSync(join(projectDir, 'assets', 'diagram.png'), 'attachment-v2');
      await engine.trigger('push');
      expect(await git.raw(['show', 'HEAD:assets/diagram.png'])).toBe('attachment-v2');

      rmSync(join(projectDir, 'assets', 'diagram.png'));
      await engine.trigger('push');
      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).not.toContain('assets/diagram.png');
      expect((await git.revparse(['origin/main'])).trim()).toBe(
        (await git.revparse(['HEAD'])).trim(),
      );
    } finally {
      await engine.destroy();
    }
  });

  test('stages files in a fixed attachment folder with no markdown document anywhere in the tree', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    // Remove the fixture's only document so nothing on disk can satisfy any
    // doc-dependent admission rule: the fixed shape must admit on its own.
    rmSync(join(projectDir, 'README.md'));
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(join(projectDir, 'assets', 'diagram.png'), 'attachment-doc-less');

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: 'assets',
      }),
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      expect(await git.raw(['show', 'HEAD:assets/diagram.png'])).toBe('attachment-doc-less');
      // The README deletion is tracked through the same scoped predicate, so
      // the push both admits the asset and drops the last document.
      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).not.toContain('README.md');
      expect((await git.revparse(['origin/main'])).trim()).toBe(
        (await git.revparse(['HEAD'])).trim(),
      );
    } finally {
      await engine.destroy();
    }
  });

  test('a live attachment-folder change freezes the old tracked folder and syncs the new one', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    mkdirSync(join(projectDir, 'media'), { recursive: true });
    writeFileSync(join(projectDir, 'assets', 'old.png'), 'old-v1');

    const contentFilter = createContentFilter({
      projectDir,
      contentDir: projectDir,
      attachmentFolderPath: 'assets',
    });
    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter,
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.trigger('push');

      contentFilter.setAttachmentFolderPath('media');
      writeFileSync(join(projectDir, 'assets', 'old.png'), 'old-v2-local');
      writeFileSync(join(projectDir, 'media', 'new.png'), 'new-v1');
      await engine.trigger('push');

      expect(await git.raw(['show', 'HEAD:assets/old.png'])).toBe('old-v1');
      expect(await git.raw(['show', 'HEAD:media/new.png'])).toBe('new-v1');
      expect(readFileSync(join(projectDir, 'assets', 'old.png'), 'utf-8')).toBe('old-v2-local');
    } finally {
      await engine.destroy();
    }
  });

  test('local-only .ok sharing does not block a configured attachment folder', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      'content:\n  attachmentFolderPath: assets\n',
    );
    writeFileSync(join(projectDir, 'assets', 'shared.png'), 'attachment');

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: createContentFilter({
        projectDir,
        contentDir: projectDir,
        attachmentFolderPath: 'assets',
      }),
      syncEnabled: true,
    });
    try {
      await engine.start();
      await engine.trigger('push');

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('assets/shared.png');
      expect(headPaths).not.toContain('.ok/config.yml');
    } finally {
      await engine.destroy();
    }
  });

  test('tracks the deletion of a shareable artifact and keeps the surviving ones', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
    await git.add(['.ok/config.yml', '.ok/schemas/frontmatter.json']);
    await git.commit('add shareable artifacts');
    await git.push(['origin', 'main']);

    rmSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'));

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).not.toContain('.ok/schemas/frontmatter.json');
      // The on-disk artifact survives: gather and head listing consult the
      // same scoped predicate, so it is never misread as a deletion.
      expect(headPaths).toContain('.ok/config.yml');

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });

  test.runIf(process.getuid?.() !== 0)(
    'fails closed on an unreadable tracked schema when content and project roots match',
    async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
      await git.add(['.ok/schemas/frontmatter.json']);
      await git.commit('track project schema');
      await git.push(['origin', 'main']);
      const headBefore = (await git.revparse(['HEAD'])).trim();
      const remoteBefore = (await git.revparse(['origin/main'])).trim();

      writeFileSync(join(projectDir, 'note.md'), '# Must stay local\n');

      const engine = makeShareableEngine();
      const cap = captureSyncLogs();
      try {
        chmodSync(join(projectDir, '.ok', 'schemas'), 0o311);
        await engine.start();
        await engine.trigger('push');

        const status = engine.getStatus();
        expect(status.pushError).toContain('Shareable .ok subtree ".ok/schemas"');
        expect(status.consecutiveFailures).toBeGreaterThan(0);
        const detail = cap.entries.find(
          (entry) => entry.msg === '[sync] push cycle: staging error detail',
        );
        expect(detail?.data.err).toBeInstanceOf(Error);
        expect((detail?.data.err as Error | undefined)?.cause).toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EPERM)$/),
        });
        expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
        expect((await git.revparse(['origin/main'])).trim()).toBe(remoteBefore);
        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(headPaths).toContain('.ok/schemas/frontmatter.json');
        expect(headPaths).not.toContain('note.md');
        expect(existsSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'))).toBe(true);
      } finally {
        cap.restore();
        chmodSync(join(projectDir, '.ok', 'schemas'), 0o755);
        await engine.destroy();
      }
    },
  );

  test.runIf(process.getuid?.() !== 0)(
    'names a nested unreadable template subtree and commits no partial snapshot',
    async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'docs', '.ok', 'templates'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', '.ok', 'templates', 'article.md'), '# Template\n');
      await git.add(['docs/.ok/templates/article.md']);
      await git.commit('track folder template');
      await git.push(['origin', 'main']);
      const headBefore = (await git.revparse(['HEAD'])).trim();
      const remoteBefore = (await git.revparse(['origin/main'])).trim();

      writeFileSync(join(projectDir, 'note.md'), '# Must stay local\n');

      const engine = makeShareableEngine();
      try {
        chmodSync(join(projectDir, 'docs', '.ok', 'templates'), 0o311);
        await engine.start();
        await engine.trigger('push');

        const status = engine.getStatus();
        expect(status.pushError).toContain(
          'Shareable .ok subtree "docs/.ok/templates" could not be fully enumerated',
        );
        expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
        expect((await git.revparse(['origin/main'])).trim()).toBe(remoteBefore);
        expect(await git.raw(['show', 'HEAD:docs/.ok/templates/article.md'])).toBe('# Template\n');
        expect(await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('note.md');
      } finally {
        chmodSync(join(projectDir, 'docs', '.ok', 'templates'), 0o755);
        await engine.destroy();
      }
    },
  );

  test('never stages .ok local state, worktrees, or legacy root state files', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, '.ok', 'worktrees', 'wt1'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');
    writeFileSync(join(projectDir, '.ok', 'local', 'principal.json'), '{}\n');
    writeFileSync(join(projectDir, '.ok', 'worktrees', 'wt1', 'scratch.md'), '# Scratch\n');
    writeFileSync(join(projectDir, '.ok', 'state.json'), '{}\n');
    writeFileSync(join(projectDir, '.ok', 'server.lock'), '{}\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('.ok/config.yml');
      expect(
        headPaths.filter((p) => p.startsWith('.ok/local/') || p.startsWith('.ok/worktrees/')),
      ).toEqual([]);
      expect(headPaths).not.toContain('.ok/state.json');
      expect(headPaths).not.toContain('.ok/server.lock');
    } finally {
      await engine.destroy();
    }
  });

  test.runIf(process.getuid?.() !== 0)(
    'reports retry staging failures as push errors',
    async () => {
      const { bareDir } = await initSharedRepoWithBareRemote();
      const { sister, sisterDir } = await cloneAsTeammate(bareDir);
      writeFileSync(join(sisterDir, 'remote.md'), '# Remote\n');
      await sister.add(['remote.md']);
      await sister.commit('advance remote');
      await sister.push(['origin', 'main']);

      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{}\n');
      writeFileSync(join(projectDir, 'local.md'), '# Local\n');
      const engine = makeShareableEngine();
      const internal = engine as unknown as {
        commitDirtyContentFilesToHead: (handle: unknown) => Promise<void>;
      };
      const commitDirty = internal.commitDirtyContentFilesToHead.bind(engine);
      internal.commitDirtyContentFilesToHead = async (handle) => {
        chmodSync(join(projectDir, '.ok', 'schemas'), 0o311);
        await commitDirty(handle);
      };

      try {
        await engine.start();
        await engine.trigger('push');

        const status = engine.getStatus();
        expect(status.pushError).toContain('Shareable .ok subtree ".ok/schemas"');
        expect(status.pullError).toBeUndefined();
      } finally {
        chmodSync(join(projectDir, '.ok', 'schemas'), 0o755);
        await engine.destroy();
      }
    },
  );

  test('refuses a secret-suffixed file inside an admitted .ok directory', async () => {
    const { git } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'api.key'), 'secret\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      expect(engine.getStatus().pushError).toBeUndefined();
      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('.ok/schemas/frontmatter.json');
      expect(headPaths).not.toContain('.ok/schemas/api.key');
    } finally {
      await engine.destroy();
    }
  });

  test('local-only projects keep every artifact class unstaged without failing the cycle', async () => {
    // Local-only sharing is a blanket `.ok/` in `.git/info/exclude`. The
    // scoped carve-out refuses git-ignored artifacts at gather time
    // (precedent #55), so `git add` is never handed a path it would fatal
    // on with addIgnoredFile. The folder template rides the ignore-blind
    // templates carve-out instead and is dropped by the staging probe —
    // both drop layers in one scenario.
    const { git } = await initSharedRepoWithBareRemote();
    writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
    mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
    mkdirSync(join(projectDir, 'docs', '.ok', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
    writeFileSync(join(projectDir, 'docs', '.ok', 'templates', 'article.md'), '# Article\n');
    writeFileSync(join(projectDir, 'note.md'), 'new note\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.pushError).toBeUndefined();
      expect(status.consecutiveFailures).toBe(0);

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('note.md');
      expect(headPaths.filter((p) => p.includes('.ok/'))).toEqual([]);

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });

  test('local-only projects freeze a tracked artifact: no edit sync, no spurious deletion', async () => {
    // Tracked while shared, then the project goes local-only. The filter
    // refuses the path on BOTH the gather walk and the head listing —
    // consulting different predicates on the two sides would misread the
    // ungathered artifact as deleted and push that deletion to teammates
    // (precedent #55). Local edits stay local; HEAD keeps the shared bytes.
    const { git } = await initSharedRepoWithBareRemote();
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');
    await git.add(['.ok/config.yml']);
    await git.commit('add config while shared');
    await git.push(['origin', 'main']);

    writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: follow\n');
    writeFileSync(join(projectDir, 'note.md'), 'new note\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('push');

      const status = engine.getStatus();
      expect(status.pushError).toBeUndefined();

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('note.md');
      expect(headPaths).toContain('.ok/config.yml');
      const blob = await git.raw(['show', 'HEAD:.ok/config.yml']);
      expect(blob).toBe('sync:\n  mode: full\n');

      const remoteHead = (await git.revparse(['origin/main'])).trim();
      expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
    } finally {
      await engine.destroy();
    }
  });

  test('follow-mode pull fast-forwards shareable artifacts into the working tree', async () => {
    const { git, bareDir } = await initSharedRepoWithBareRemote();
    const { sister, sisterDir } = await cloneAsTeammate(bareDir);
    mkdirSync(join(sisterDir, '.ok', 'schemas'), { recursive: true });
    writeFileSync(join(sisterDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
    await sister.add(['.ok/schemas/frontmatter.json']);
    await sister.commit('teammate adds schema');
    await sister.push(['origin', 'main']);

    const engine = makeShareableEngine('follow');
    try {
      await engine.start();
      await engine.trigger('pull');

      expect(existsSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'))).toBe(true);
      expect((await git.revparse(['HEAD'])).trim()).toBe(
        (await git.revparse(['origin/main'])).trim(),
      );
    } finally {
      await engine.destroy();
    }
  });

  test('pull with locally edited shareable artifacts commits them before merging', async () => {
    // Exercises the second staging path: the pre-merge dirty-content commit,
    // not the push cycle, is what stages the artifact here.
    const { git, bareDir } = await initSharedRepoWithBareRemote();
    const { sister, sisterDir } = await cloneAsTeammate(bareDir);
    writeFileSync(join(sisterDir, 'from-teammate.md'), '# Teammate\n');
    await sister.add(['from-teammate.md']);
    await sister.commit('teammate note');
    await sister.push(['origin', 'main']);

    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'sync:\n  mode: full\n');

    const engine = makeShareableEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const status = engine.getStatus();
      expect(status.conflictCount).toBe(0);
      expect(status.pausedReason).toBeUndefined();
      expect(status.state).toBe('idle');
      expect(existsSync(join(projectDir, 'from-teammate.md'))).toBe(true);

      const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(headPaths).toContain('.ok/config.yml');
      const blob = await git.raw(['show', 'HEAD:.ok/config.yml']);
      expect(blob).toBe('sync:\n  mode: full\n');
    } finally {
      await engine.destroy();
    }
  });

  test('auto-resolves non-document artifacts but preserves template content conflicts', async () => {
    const { git, bareDir } = await initSharedRepoWithBareRemote();
    mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
    mkdirSync(join(projectDir, '.ok', 'templates'), { recursive: true });
    mkdirSync(join(projectDir, 'docs', '.ok', 'templates'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'shared: base\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'lint.json'), '{"a":1}\n');
    writeFileSync(join(projectDir, '.ok', 'templates', 'project.md'), '# Base project\n');
    writeFileSync(join(projectDir, 'docs', '.ok', 'templates', 'folder.md'), '# Base folder\n');
    await git.add([
      '.ok/config.yml',
      '.ok/schemas/lint.json',
      '.ok/templates/project.md',
      'docs/.ok/templates/folder.md',
    ]);
    await git.commit('add shareable artifacts');
    await git.push(['origin', 'main']);

    const { sister, sisterDir } = await cloneAsTeammate(bareDir);
    writeFileSync(join(sisterDir, '.ok', 'config.yml'), 'shared: remote\n');
    writeFileSync(join(sisterDir, '.ok', 'schemas', 'lint.json'), '{"a":99}\n');
    writeFileSync(join(sisterDir, '.ok', 'templates', 'project.md'), '# Remote project\n');
    writeFileSync(join(sisterDir, 'docs', '.ok', 'templates', 'folder.md'), '# Remote folder\n');
    await sister.add([
      '.ok/config.yml',
      '.ok/schemas/lint.json',
      '.ok/templates/project.md',
      'docs/.ok/templates/folder.md',
    ]);
    await sister.commit('teammate edits config and schema');
    await sister.push(['origin', 'main']);

    writeFileSync(join(projectDir, '.ok', 'config.yml'), 'shared: local\n');
    writeFileSync(join(projectDir, '.ok', 'schemas', 'lint.json'), '{"a":2}\n');
    writeFileSync(join(projectDir, '.ok', 'templates', 'project.md'), '# Local project\n');
    writeFileSync(join(projectDir, 'docs', '.ok', 'templates', 'folder.md'), '# Local folder\n');

    const engine = makeShareableEngine();
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.trigger('pull');

      // Non-document artifacts take theirs, while templates keep the ordinary
      // content-conflict lifecycle because users can resolve them in the editor.
      const status = engine.getStatus();
      expect(status.state).toBe('conflict');
      expect(status.pausedReason).toBeUndefined();
      expect(status.conflictCount).toBe(2);
      expect(
        engine
          .getConflicts()
          .map((conflict) => conflict.file)
          .sort(),
      ).toEqual(['.ok/templates/project.md', 'docs/.ok/templates/folder.md']);
      expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(readFileSync(join(projectDir, '.ok', 'config.yml'), 'utf-8')).toBe('shared: remote\n');
      expect(readFileSync(join(projectDir, '.ok', 'schemas', 'lint.json'), 'utf-8')).toBe(
        '{"a":99}\n',
      );

      const unmerged = await git.raw(['diff', '--name-only', '--diff-filter=U']);
      expect(unmerged.trim().split('\n').sort()).toEqual([
        '.ok/templates/project.md',
        'docs/.ok/templates/folder.md',
      ]);

      const configResolves = cap.entries.filter(
        (e) => e.msg.includes('auto-resolved') && e.data.file === '.ok/config.yml',
      );
      expect(configResolves).toHaveLength(1);
      expect(configResolves[0]?.level).toBe('warn');
      expect(configResolves[0]?.msg).toContain('local project config edits were overwritten');

      const schemaResolves = cap.entries.filter(
        (e) => e.msg.includes('auto-resolved') && e.data.file === '.ok/schemas/lint.json',
      );
      expect(schemaResolves).toHaveLength(1);
      expect(schemaResolves[0]?.level).toBe('info');
      expect(schemaResolves[0]?.msg).toBe('[sync] auto-resolved non-content conflict with theirs');

      const templateResolves = cap.entries.filter(
        (e) => e.msg.includes('auto-resolved') && String(e.data.file).includes('/templates/'),
      );
      expect(templateResolves).toEqual([]);
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  describe('with content.dir as a subfolder (project-root shareable set)', () => {
    // The content walk starts at contentDir, so the project-root `.ok/` sits
    // entirely outside it in this configuration — these tests pin the second
    // enumeration rooted at the project root.

    function makeSubfolderEngine(attachmentFolderPath?: string) {
      const contentDir = join(projectDir, 'content');
      return new SyncEngine({
        projectDir,
        contentDir,
        contentFilter: createContentFilter({
          projectDir,
          contentDir,
          ...(attachmentFolderPath ? { attachmentFolderPath } : {}),
        }),
        syncEnabled: true,
      });
    }

    test('configured attachment folders stay content-relative when content.dir is a subfolder', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content', 'assets'), { recursive: true });
      writeFileSync(join(projectDir, 'content', 'assets', 'diagram.png'), 'attachment');

      const engine = makeSubfolderEngine('assets');
      try {
        await engine.start();
        await engine.trigger('push');

        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(headPaths).toContain('content/assets/diagram.png');
        expect(headPaths).not.toContain('assets/diagram.png');
      } finally {
        await engine.destroy();
      }
    });

    test('stages the project-root shareable set alongside subfolder content', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content', 'docs', '.ok'), { recursive: true });
      mkdirSync(join(projectDir, 'content', '.ok', 'schemas'), { recursive: true });
      mkdirSync(join(projectDir, 'content', '.ok', 'templates'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'templates'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), 'content:\n  dir: content\n');
      writeFileSync(join(projectDir, '.ok', '.gitignore'), 'local/\nworktrees/\n');
      writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
      writeFileSync(join(projectDir, '.ok', 'templates', 'meeting.md'), '# Meeting\n');
      writeFileSync(join(projectDir, 'content', '.ok', 'config.yml'), 'wrong: root\n');
      writeFileSync(join(projectDir, 'content', '.ok', '.gitignore'), 'local/\n');
      writeFileSync(join(projectDir, 'content', '.ok', 'schemas', 'nested.json'), '{}\n');
      writeFileSync(join(projectDir, 'content', '.ok', 'templates', 'daily.md'), '# Daily\n');
      writeFileSync(join(projectDir, 'content', 'note.md'), '# Note\n');
      writeFileSync(join(projectDir, 'content', 'docs', '.ok', 'config.yml'), 'not: project\n');
      writeFileSync(join(projectDir, 'content', 'docs', '.ok', 'frontmatter.yml'), 'icon: book\n');

      const engine = makeSubfolderEngine();
      try {
        await engine.start();
        await engine.trigger('push');

        const status = engine.getStatus();
        expect(status.pushError).toBeUndefined();
        expect(status.consecutiveFailures).toBe(0);

        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        for (const path of [
          '.ok/config.yml',
          '.ok/.gitignore',
          '.ok/schemas/frontmatter.json',
          '.ok/templates/meeting.md',
          'content/.ok/templates/daily.md',
          'content/note.md',
          'content/docs/.ok/frontmatter.yml',
        ]) {
          expect(headPaths).toContain(path);
        }
        expect(headPaths).not.toContain('content/.ok/config.yml');
        expect(headPaths).not.toContain('content/.ok/.gitignore');
        expect(headPaths).not.toContain('content/.ok/schemas/nested.json');
        expect(headPaths).not.toContain('content/docs/.ok/config.yml');

        const remoteHead = (await git.revparse(['origin/main'])).trim();
        expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
      } finally {
        await engine.destroy();
      }
    });

    test('tracks deletion of a project-root artifact and keeps the survivors', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), 'content:\n  dir: content\n');
      writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
      writeFileSync(join(projectDir, 'content', 'note.md'), '# Note\n');
      await git.add(['.ok/config.yml', '.ok/schemas/frontmatter.json', 'content/note.md']);
      await git.commit('add shareable artifacts');
      await git.push(['origin', 'main']);

      rmSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'));

      const engine = makeSubfolderEngine();
      try {
        await engine.start();
        await engine.trigger('push');

        expect(engine.getStatus().pushError).toBeUndefined();
        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(headPaths).not.toContain('.ok/schemas/frontmatter.json');
        // Survivors pin gather/head-listing symmetry across both walk roots.
        expect(headPaths).toContain('.ok/config.yml');
        expect(headPaths).toContain('content/note.md');

        const remoteHead = (await git.revparse(['origin/main'])).trim();
        expect(remoteHead).toBe((await git.revparse(['HEAD'])).trim());
      } finally {
        await engine.destroy();
      }
    });

    test('folder artifacts outside contentDir and outside the root .ok stay frozen', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content'), { recursive: true });
      mkdirSync(join(projectDir, 'docs', '.ok'), { recursive: true });
      writeFileSync(join(projectDir, 'docs', '.ok', 'frontmatter.yml'), 'icon: book\n');
      await git.add(['docs/.ok/frontmatter.yml']);
      await git.commit('folder metadata outside the content walk');
      await git.push(['origin', 'main']);

      mkdirSync(join(projectDir, 'docs2', '.ok'), { recursive: true });
      writeFileSync(join(projectDir, 'docs2', '.ok', 'frontmatter.yml'), 'icon: rocket\n');
      writeFileSync(join(projectDir, 'content', 'note.md'), '# Note\n');

      const engine = makeSubfolderEngine();
      try {
        await engine.start();
        await engine.trigger('push');

        expect(engine.getStatus().pushError).toBeUndefined();
        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        // The second enumeration is bounded to the project-root `.ok`: a
        // tracked folder artifact outside both walk roots must not be misread
        // as a deletion, and an untracked one must not be gathered.
        expect(headPaths).toContain('docs/.ok/frontmatter.yml');
        expect(headPaths).not.toContain('docs2/.ok/frontmatter.yml');
        expect(headPaths).toContain('content/note.md');
      } finally {
        await engine.destroy();
      }
    });

    test('the second walk still refuses local state, legacy files, and secrets', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'worktrees', 'wt1'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'schemas', 'lint.json'), '{"type":"object"}\n');
      writeFileSync(join(projectDir, '.ok', 'schemas', 'api.key'), 'secret\n');
      writeFileSync(join(projectDir, '.ok', 'local', 'principal.json'), '{}\n');
      writeFileSync(join(projectDir, '.ok', 'worktrees', 'wt1', 'scratch.md'), '# Scratch\n');
      writeFileSync(join(projectDir, '.ok', 'state.json'), '{}\n');
      writeFileSync(join(projectDir, 'content', 'note.md'), '# Note\n');

      const engine = makeSubfolderEngine();
      try {
        await engine.start();
        await engine.trigger('push');

        expect(engine.getStatus().pushError).toBeUndefined();
        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(headPaths).toContain('.ok/schemas/lint.json');
        expect(headPaths).toContain('content/note.md');
        for (const path of headPaths) {
          expect(path).not.toMatch(/^\.ok\/(local|worktrees)\//);
        }
        expect(headPaths).not.toContain('.ok/schemas/api.key');
        expect(headPaths).not.toContain('.ok/state.json');
      } finally {
        await engine.destroy();
      }
    });

    test('local-only subfolder projects keep the project-root set unstaged without errors', async () => {
      const { git } = await initSharedRepoWithBareRemote();
      mkdirSync(join(projectDir, 'content'), { recursive: true });
      mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
      writeFileSync(join(projectDir, '.ok', 'config.yml'), 'content:\n  dir: content\n');
      writeFileSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'), '{"type":"object"}\n');
      writeFileSync(join(projectDir, 'content', 'note.md'), '# Note\n');
      // Written before the engine (and its filter) is constructed — the
      // filter reads ignore sources at creation.
      writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.ok/\n');

      const engine = makeSubfolderEngine();
      try {
        await engine.start();
        await engine.trigger('push');

        const status = engine.getStatus();
        expect(status.pushError).toBeUndefined();
        expect(status.consecutiveFailures).toBe(0);
        const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(headPaths).toContain('content/note.md');
        expect(headPaths.filter((p) => p.startsWith('.ok/'))).toEqual([]);
      } finally {
        await engine.destroy();
      }
    });

    // An unreadable project-root `.ok` makes deletion tracking ambiguous.
    // Execute-only permissions keep by-name traversal working while readdir
    // fails; skipped as root, where chmod does not restrict access.
    test.runIf(process.getuid?.() !== 0)(
      'fails closed when a tracked project-root .ok is unreadable',
      async () => {
        const { git } = await initSharedRepoWithBareRemote();
        mkdirSync(join(projectDir, 'content'), { recursive: true });
        writeFileSync(join(projectDir, '.ok', 'config.yml'), 'content:\n  dir: content\n');
        mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
        await git.add(['.ok/config.yml']);
        await git.commit('track project config');
        await git.push(['origin', 'main']);
        const headBefore = (await git.revparse(['HEAD'])).trim();
        const remoteBefore = (await git.revparse(['origin/main'])).trim();

        writeFileSync(join(projectDir, 'content', 'note.md'), '# Must stay local\n');

        const engine = makeSubfolderEngine();
        try {
          chmodSync(join(projectDir, '.ok'), 0o311);
          await engine.start();
          await engine.trigger('push');

          const status = engine.getStatus();
          expect(status.pushError).toContain('Shareable .ok subtree ".ok"');
          expect(status.consecutiveFailures).toBeGreaterThan(0);
          expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
          expect((await git.revparse(['origin/main'])).trim()).toBe(remoteBefore);
          const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
          expect(headPaths).toContain('.ok/config.yml');
          expect(headPaths).not.toContain('content/note.md');
          expect(existsSync(join(projectDir, '.ok', 'config.yml'))).toBe(true);
        } finally {
          chmodSync(join(projectDir, '.ok'), 0o755);
          await engine.destroy();
        }
      },
    );

    test.runIf(process.getuid?.() !== 0)(
      'fails closed when a tracked project-root schema directory is unreadable',
      async () => {
        const { git } = await initSharedRepoWithBareRemote();
        mkdirSync(join(projectDir, 'content'), { recursive: true });
        mkdirSync(join(projectDir, '.ok', 'schemas'), { recursive: true });
        mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
        writeFileSync(
          join(projectDir, '.ok', 'schemas', 'frontmatter.json'),
          '{"type":"object"}\n',
        );
        await git.add(['.ok/schemas/frontmatter.json']);
        await git.commit('track project schema');
        await git.push(['origin', 'main']);
        const headBefore = (await git.revparse(['HEAD'])).trim();
        const remoteBefore = (await git.revparse(['origin/main'])).trim();

        writeFileSync(join(projectDir, 'content', 'note.md'), '# Must stay local\n');

        const engine = makeSubfolderEngine();
        try {
          chmodSync(join(projectDir, '.ok', 'schemas'), 0o311);
          await engine.start();
          await engine.trigger('push');

          const status = engine.getStatus();
          expect(status.pushError).toContain('Shareable .ok subtree ".ok/schemas"');
          expect(status.consecutiveFailures).toBeGreaterThan(0);
          expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore);
          expect((await git.revparse(['origin/main'])).trim()).toBe(remoteBefore);
          const headPaths = await listNames(git, ['ls-tree', '-r', '--name-only', 'HEAD']);
          expect(headPaths).toContain('.ok/schemas/frontmatter.json');
          expect(headPaths).not.toContain('content/note.md');
          expect(existsSync(join(projectDir, '.ok', 'schemas', 'frontmatter.json'))).toBe(true);
        } finally {
          chmodSync(join(projectDir, '.ok', 'schemas'), 0o755);
          await engine.destroy();
        }
      },
    );
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

  test('probes a GitHub Enterprise origin against the enterprise host', async () => {
    await initGitWithOrigin('https://ghes.acme.test/inkeep/open-knowledge.git');
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(probe.calls).toBe(1);
    expect(probe.opts[0]).toMatchObject({
      owner: 'inkeep',
      repo: 'open-knowledge',
      host: 'ghes.acme.test',
    });
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

  test('passes the origin transport through to the probe (ssh origin)', async () => {
    await initGitWithOrigin('git@git.example.com:acme/kb.git');
    const probe = fakeProbe({ kind: 'unknown', error: 'ssh-unverified' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    expect(probe.opts[0]).toMatchObject({
      owner: 'acme',
      repo: 'kb',
      host: 'git.example.com',
      transport: 'ssh',
    });
  });

  test('ssh-unverified probe result does NOT pause the engine (self-hosted forge over SSH)', async () => {
    // The regression behind the forge sync pause: an SSH-origin user with no
    // gh/OK token used to land in denied/not-authenticated → pausedReason=
    // 'no-push-permission' → disabled, with a GitHub Sign-in button that can
    // never help. The abstaining probe result must leave sync running.
    await initGitWithOrigin('git@git.example.com:acme/kb.git');
    const probe = fakeProbe({ kind: 'unknown', error: 'ssh-unverified' });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: probe.fn });
    await engine.start();
    await waitForPushPermissionResolved(engine);
    const status = engine.getStatus();
    expect(status.pushPermission).toEqual({
      checkStatus: 'unknown',
      unknownError: 'ssh-unverified',
    });
    expect(status.state).toBe('idle');
    expect(status.pausedReason).not.toBe('no-push-permission');
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

  test('resolves the gh token against a GitHub Enterprise origin host', async () => {
    await initGitWithOrigin('https://ghes.acme.test/inkeep/open-knowledge.git');
    const detect = recordDetectGh({ available: true, token: 'gho_relayed' });
    const engine = new SyncEngine({
      projectDir,
      contentDir,
      contentFilter: stubContentFilter,
      syncEnabled: true,
      detectGh: detect.fn,
    });
    try {
      (engine as unknown as { gitHandle: () => unknown }).gitHandle();
      expect(detect.calls()).toBe(1);
      expect(detect.lastHost()).toBe('ghes.acme.test');
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

// ─── Sync mode representation ─────────────────────────────────────────────────

describe('SyncEngine sync mode', () => {
  test('constructing with a mode reports it in status', () => {
    expect(makeEngine({ mode: 'follow' }).getStatus().syncMode).toBe('follow');
    expect(makeEngine({ mode: 'full' }).getStatus().syncMode).toBe('full');
    expect(makeEngine({ mode: 'off' }).getStatus().syncMode).toBe('off');
  });

  test('syncEnabled is true for pull and full, false for off', () => {
    // syncEnabled is the "is sync on at all" boolean; both directional modes are
    // "on". Consumers that must branch on push capability read syncMode instead.
    expect(makeEngine({ mode: 'follow' }).getStatus().syncEnabled).toBe(true);
    expect(makeEngine({ mode: 'full' }).getStatus().syncEnabled).toBe(true);
    expect(makeEngine({ mode: 'off' }).getStatus().syncEnabled).toBe(false);
  });

  test('legacy syncEnabled option maps to a mode (true→full, else off)', () => {
    expect(makeEngine({ syncEnabled: true }).getStatus().syncMode).toBe('full');
    expect(makeEngine({ syncEnabled: false }).getStatus().syncMode).toBe('off');
    expect(makeEngine({}).getStatus().syncMode).toBe('off');
  });

  test('setEnabled adapter maps to a mode (true→full, false→off)', async () => {
    const engine = makeEngine({ mode: 'off' });
    try {
      await engine.setEnabled(true);
      expect(engine.getStatus().syncMode).toBe('full');
      await engine.setEnabled(false);
      expect(engine.getStatus().syncMode).toBe('off');
    } finally {
      await engine.destroy();
    }
  });

  test('setMode records the new mode', async () => {
    const engine = makeEngine({ mode: 'off' });
    try {
      await engine.setMode('follow');
      expect(engine.getStatus().syncMode).toBe('follow');
    } finally {
      await engine.destroy();
    }
  });

  test('setMode is a no-op on a same-value call', async () => {
    const states: SyncState[] = [];
    const engine = makeEngine({ mode: 'off', onStateChange: (s) => states.push(s) });
    try {
      await engine.setMode('off');
      expect(states).toEqual([]);
      expect(engine.getStatus().syncMode).toBe('off');
    } finally {
      await engine.destroy();
    }
  });

  test('getStatus() output conforms to the wire schema and carries syncMode', () => {
    // getStatus() is exactly what the /api/sync/status handler serializes
    // (successResponse validates it against SyncStatusSchema), so parsing it
    // against that schema pins the server-output ↔ wire-contract seam.
    const parsed = SyncStatusSchema.safeParse(makeEngine({ mode: 'follow' }).getStatus());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.syncMode).toBe('follow');
  });
});

// ─── Pull-only mode ───────────────────────────────────────────────────────────
//
// A pull-only project fetches and fast-forwards but is never pushed for. These
// tests use real bare-origin + clone fixtures so the fetch/FF path runs for
// real, and pin the two push-side guarantees: (1) the push cycle never runs, so
// protected-branch — a push-only pause — is unreachable; (2) a denied push probe
// does not park the engine (pull-only expects to lack push).
//
// Under pull-only the legacy dirty-tree merge path does not run: the FF-only B1
// cycle below replaces it, never committing or stashing on the user's behalf, so
// the dirty-merge that produces the self-heal pause cannot arise for this mode.

describe('SyncEngine pull-only mode', () => {
  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  test('pull cycle fast-forwards the clone to origin tip and updates the working tree', async () => {
    const bareDir = await seedBareOrigin();

    // A sister seeds origin, the project clones it, then the sister advances
    // origin by one commit — leaving the project one commit behind.
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, 'doc.md'), 'v1\n', 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });

    writeFileSync(join(sisterDir, 'doc.md'), 'v1\nv2\n', 'utf-8');
    await sister.add('.');
    await sister.commit('advance');
    await sister.push('origin', 'main');
    const originTip = (await sister.revparse(['HEAD'])).trim();

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
    });
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'doc.md'), 'utf-8')).toBe('v1\nv2\n');
      // A fast-forward creates no commit and leaves no merge in progress.
      expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(engine.getStatus().state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });

  test('never pushes local commits (push cycle is gated off)', async () => {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, 'README.md'), '# seed\n');
    await git.add('.');
    await git.commit('seed');

    const bareDir = await seedBareOrigin();
    await git.addRemote('origin', bareDir);
    await git.push(['--set-upstream', 'origin', 'main']);
    const originBefore = (await git.revparse(['origin/main'])).trim();

    // A local commit the project has not pushed. Full sync would push it; a
    // pull-only project must leave it local.
    writeFileSync(join(projectDir, 'README.md'), '# seed\n\nlocal edit\n');
    await git.add('.');
    await git.commit('local commit not pushed');
    expect((await git.revparse(['HEAD'])).trim()).not.toBe(originBefore);

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
    });
    try {
      await engine.start();
      // Both a direct push trigger and a full sync (push-then-pull) must leave
      // origin untouched — the push gate makes the push cycle a no-op.
      await engine.trigger('push');
      await engine.trigger('sync');

      expect((await git.revparse(['origin/main'])).trim()).toBe(originBefore);
      const status = engine.getStatus();
      expect(status.lastPushedSha).toBeNull();
      // protected-branch is a push-rejection pause; with the push cycle gated
      // off it can never be classified, so it is structurally unreachable here.
      expect(status.pausedReason).not.toBe('protected-branch');
    } finally {
      await engine.destroy();
    }
  });

  test('a denied push probe keeps the engine pulling (no pause)', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ mode: 'follow', fakeProbe: probe.fn });
    try {
      await engine.start();
      await waitForPushPermissionResolved(engine);
      const status = engine.getStatus();
      expect(status.pushPermission).toEqual({
        checkStatus: 'denied',
        deniedReason: 'no-collaborator',
      });
      // Pull-only expects to lack push — denial is its normal condition, so the
      // engine stays idle and keeps its scheduled pulls rather than parking.
      expect(status.state).not.toBe('disabled');
      expect(status.pausedReason).not.toBe('no-push-permission');
      expect(status.syncMode).toBe('follow');
    } finally {
      await engine.destroy();
    }
  });

  test('a denied push probe still pauses a full-sync engine (unchanged behavior)', async () => {
    await initGitWithOrigin();
    const probe = fakeProbe({ kind: 'denied', reason: 'no-collaborator' });
    const engine = makeProbeEngine({ mode: 'full', fakeProbe: probe.fn });
    try {
      await engine.start();
      await waitForPushPermissionResolved(engine);
      const status = engine.getStatus();
      expect(status.state).toBe('disabled');
      expect(status.pausedReason).toBe('no-push-permission');
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Pull-only B1 fast-forward cycle ───────────────────────────────────────────
//
// The B1 cycle fast-forwards a pull-only clone to origin's tip while any
// uncommitted local edits ride along as a working-tree overlay, and it never
// commits, merges, stashes, or leaves a MERGE_HEAD. These tests drive the real
// git fetch/FF path against bare-origin + clone fixtures and pin the overlay
// matrix from the spike: non-overlap rides through, byte-identical converges,
// same-file overlap keeps-mine on the new tip, and — the asymmetric git guard —
// a locally-deleted file the tip modifies is NOT resurrected.

describe('SyncEngine pull-only B1 fast-forward cycle', () => {
  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  /**
   * Seed origin from a sister clone, clone it into `projectDir`, then advance
   * origin — leaving the project one commit behind. `advance` values: a string
   * rewrites the file, `null` deletes it on origin. Returns origin's tip SHA and
   * the sister handle (so a caller can advance origin further).
   */
  async function cloneBehindOrigin(opts: {
    seed: Record<string, string>;
    advance: Record<string, string | null>;
  }): Promise<{ originTip: string; bareDir: string }> {
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    for (const [f, c] of Object.entries(opts.seed)) writeFileSync(join(sisterDir, f), c, 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });

    for (const [f, c] of Object.entries(opts.advance)) {
      if (c === null) rmSync(join(sisterDir, f), { force: true });
      else writeFileSync(join(sisterDir, f), c, 'utf-8');
    }
    await sister.raw(['add', '-A']);
    await sister.commit('advance');
    await sister.push('origin', 'main');
    return { originTip: (await sister.revparse(['HEAD'])).trim(), bareDir };
  }

  function makePullEngine(
    opts: {
      onContentConflictsResolved?: (files: string[]) => void | Promise<void>;
      onContentConflictsDetected?: (files: string[]) => void | Promise<void>;
    } = {},
  ) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
      onContentConflictsResolved: opts.onContentConflictsResolved,
      onContentConflictsDetected: opts.onContentConflictsDetected,
    });
  }

  /** No commit, no merge in progress, no stash — the B1 no-side-effect contract. */
  async function assertNoGitResidue(): Promise<void> {
    expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(false);
    const stashList = await simpleGit(projectDir).raw(['stash', 'list']);
    expect(stashList.trim()).toBe('');
  }

  test('non-overlapping local edit survives the fast-forward', async () => {
    // Local uncommitted edit to a.md; origin advances b.md. The FF brings b.md
    // and leaves a.md's overlay untouched.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'A1\n', 'b.md': 'B1\n' },
      advance: { 'b.md': 'B1\nB2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'A1\nLOCAL\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'b.md'), 'utf-8')).toBe('B1\nB2\n');
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('A1\nLOCAL\n');
      // git status shows only the overlay file dirty.
      expect(await listNames(project, ['diff-index', '--name-only', 'HEAD'])).toEqual(['a.md']);
      await assertNoGitResidue();
      expect(engine.getStatus().state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });

  test('a byte-identical overlay converges silently', async () => {
    // The local edit equals origin's incoming bytes. git's FF guard would refuse
    // (it compares worktree-vs-HEAD, not vs the tip), so the cycle must restore
    // and let the FF re-materialise the identical bytes — leaving a clean tree.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'v1\n' },
      advance: { 'a.md': 'v1\nv2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'v1\nv2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('v1\nv2\n');
      // Converged: the file matches the new tip, so the tree is clean.
      expect(await listNames(project, ['diff-index', '--name-only', 'HEAD'])).toEqual([]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a locally-deleted content file the tip modifies is restored from origin', async () => {
    // Pull-only follows upstream: a locally-deleted content doc the tip modified
    // yields to the remote's change and is restored at origin's version (nothing
    // authored is lost — the local side was a deletion). Not conflicted, not gone.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'C1\n', 'keep.md': 'K1\n' },
      advance: { 'a.md': 'C1\nC2\n', 'keep.md': 'K1\nK2\n' },
    });
    rmSync(join(projectDir, 'a.md'), { force: true });

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      // Restored at origin's version — the deletion yielded to upstream.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('C1\nC2\n');
      // The non-overlapping origin change still landed.
      expect(readFileSync(join(projectDir, 'keep.md'), 'utf-8')).toBe('K1\nK2\n');
      expect(engine.getConflicts()).toEqual([]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a locally-deleted NON-content file the tip modifies stays deleted', async () => {
    // The follow-upstream restore is scoped to content docs. A non-content file
    // (config/asset) deleted locally keeps its deletion even when origin edits it.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'cfg.json': '{"a":1}\n', 'keep.md': 'K1\n' },
      advance: { 'cfg.json': '{"a":2}\n', 'keep.md': 'K1\nK2\n' },
    });
    rmSync(join(projectDir, 'cfg.json'), { force: true });

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      // Deletion preserved for the non-content file; the .md change still landed.
      expect(existsSync(join(projectDir, 'cfg.json'))).toBe(false);
      expect(readFileSync(join(projectDir, 'keep.md'), 'utf-8')).toBe('K1\nK2\n');
      expect(engine.getConflicts()).toEqual([]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('same-file overlap keeps the local edit while the branch reaches origin tip', async () => {
    // Local and origin both rewrite a.md's first line (a genuine overlap); origin
    // also advances b.md (non-overlapping). The branch fast-forwards to the tip,
    // b.md updates, and a.md keeps the local overlay — with no commit created.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n', 'b.md': 'B1\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n', 'b.md': 'B1\nB2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'b.md'), 'utf-8')).toBe('B1\nB2\n');
      // keep-mine: the local overlay rides on the advanced tip.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      expect(await listNames(project, ['diff-index', '--name-only', 'HEAD'])).toEqual(['a.md']);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('checkpoints the overlay before the reset, capturing the pre-reset bytes', async () => {
    // Same-file overlap: the cycle resets a.md to HEAD before the FF, then
    // re-writes the overlay. The checkpoint must fire BEFORE the reset, while the
    // local bytes are still on disk, so a crash in the reset->rewrite window
    // leaves them recoverable on the shadow timeline.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const seen: Array<{ paths: number; bytesAtCheckpoint: string }> = [];
    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
      checkpointBeforeOverlayRestore: ({ paths }) => {
        seen.push({ paths, bytesAtCheckpoint: readFileSync(join(projectDir, 'a.md'), 'utf-8') });
      },
    });
    try {
      await engine.start();
      await engine.trigger('pull');

      expect(seen).toHaveLength(1);
      expect(seen[0]?.paths).toBe(1);
      // Ordering proof: the overlay was still on disk when the checkpoint ran.
      expect(seen[0]?.bytesAtCheckpoint).toBe('LOCAL1\nline2\n');
      // The cycle still completed normally.
      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('does not checkpoint when the pull has no overlapping edit', async () => {
    // Non-overlapping overlay (local a.md, origin advances b.md): no reset, no
    // crash window, so no checkpoint is owed.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'A1\n', 'b.md': 'B1\n' },
      advance: { 'b.md': 'B1\nB2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'A1\nLOCAL\n', 'utf-8');

    let calls = 0;
    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
      checkpointBeforeOverlayRestore: () => {
        calls += 1;
      },
    });
    try {
      await engine.start();
      await engine.trigger('pull');

      expect(calls).toBe(0);
      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
    } finally {
      await engine.destroy();
    }
  });

  test('a failing overlay checkpoint does not abort the cycle', async () => {
    // The checkpoint is a best-effort safety net: a failure forfeits only the
    // crash-window recovery, so the pull must still fast-forward and keep-mine.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode: 'follow',
      checkpointBeforeOverlayRestore: () => {
        throw new Error('shadow unavailable');
      },
    });
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('refuses to write an overlay through a symlink escaping the repo, and surfaces the failure', async () => {
    // A git remote is untrusted: it can turn a tracked content file the follower
    // also edited into a symlink pointing outside the working tree. After the FF
    // materialises the link, re-applying the overlay must refuse (realpath
    // escape) rather than following it out of the repo — and must surface an
    // error, not report a clean pull.
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, 'a.md'), 'A1\n', 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });

    // Follower edits a.md locally — the overlay the cycle will try to re-apply.
    writeFileSync(join(projectDir, 'a.md'), 'A1\nLOCAL\n', 'utf-8');

    // Origin replaces a.md with a symlink to a file OUTSIDE the repo.
    const escapeTarget = join(tmpDir, 'escape-target.txt');
    writeFileSync(escapeTarget, 'PRECIOUS\n', 'utf-8');
    rmSync(join(sisterDir, 'a.md'), { force: true });
    symlinkSync(escapeTarget, join(sisterDir, 'a.md'));
    await sister.raw(['add', '-A']);
    await sister.commit('a.md -> escape');
    await sister.push('origin', 'main');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      // Containment: the out-of-repo file was NOT overwritten with the overlay.
      expect(readFileSync(escapeTarget, 'utf-8')).toBe('PRECIOUS\n');
      // Surfaced as an error outcome — not a clean 'succeeded'/'conflict' idle.
      expect(engine.getStatus().lastPullOutcome).toBe('error');
    } finally {
      await engine.destroy();
    }
  });

  test('diverged local history pauses instead of merging', async () => {
    // A local commit ahead of origin cannot fast-forward. Pull-only refuses to
    // merge/commit it — the branch stays put and a bounded paused reason surfaces.
    const { bareDir } = await cloneBehindOrigin({
      seed: { 'a.md': 'v1\n' },
      advance: { 'a.md': 'v1\nORIGIN\n' },
    });
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Follower');
    await project.raw('config', 'user.email', 'follower@test.com');
    writeFileSync(join(projectDir, 'a.md'), 'v1\nLOCAL COMMIT\n', 'utf-8');
    await project.add('.');
    await project.commit('local commit ahead');
    const localTip = (await project.revparse(['HEAD'])).trim();

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      // Branch unchanged (not fast-forwarded onto origin), no merge commit made.
      expect((await project.revparse(['HEAD'])).trim()).toBe(localTip);
      expect(engine.getStatus().pausedReason).toBe('diverged-local-commits');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
    expect(bareDir).toContain('bare.git'); // fixture sanity
  });

  test('different-line edits to the same file auto-combine with no conflict', async () => {
    // Local edits the first line; origin edits the third line. diff3 combines
    // them into one overlay with no prompt.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'L1\nL2\nL3\n' },
      advance: { 'a.md': 'L1\nL2\nORIGIN3\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nL2\nL3\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      // Both edits present in the combined overlay.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nL2\nORIGIN3\n');
      expect(engine.getConflicts()).toEqual([]);
      expect(engine.getStatus().state).toBe('idle');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('same-line collision raises a pinned working-tree conflict and never forks', async () => {
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      // Branch reached origin tip; local overlay kept on disk; no commit.
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      await assertNoGitResidue();

      const conflicts = engine.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.file).toBe('a.md');
      expect(conflicts[0]?.variant).toBe('working-tree');
      expect(conflicts[0]?.theirsSha).toMatch(/^[0-9a-f]{40}$/);
      expect(conflicts[0]?.baseSha).toMatch(/^[0-9a-f]{40}$/);
      // The engine stays idle, not paused, so the rest of the repo keeps pulling.
      expect(engine.getStatus().state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });

  test('a non-content overlap keeps the local edit without raising a conflict', async () => {
    // A `.json` config is not an OK content doc, so a same-line overlap keeps the
    // local edit verbatim (never line-merged) and is never surfaced as a conflict
    // the user has no editor to resolve.
    const { originTip } = await cloneBehindOrigin({
      seed: { 'config.json': '{"a":1}\n' },
      advance: { 'config.json': '{"a":2}\n' },
    });
    writeFileSync(join(projectDir, 'config.json'), '{"a":3}\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'config.json'), 'utf-8')).toBe('{"a":3}\n');
      expect(engine.getConflicts()).toEqual([]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a locally-deleted content file the tip modifies is restored, not conflicted', async () => {
    const { originTip } = await cloneBehindOrigin({
      seed: { 'a.md': 'C1\n' },
      advance: { 'a.md': 'C1\nC2\n' },
    });
    rmSync(join(projectDir, 'a.md'), { force: true });

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      // Pull-only accepts the remote's change: the file is restored at origin's
      // version with no conflict raised.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('C1\nC2\n');
      expect(engine.getConflicts()).toEqual([]);
      expect(engine.getStatus().state).toBe('idle');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  /** Advance origin again from the sister clone; returns the new tip SHA. */
  async function advanceOriginFrom(files: Record<string, string | null>): Promise<string> {
    const sisterDir = join(tmpDir, 'sister');
    const sister = simpleGit(sisterDir);
    for (const [f, c] of Object.entries(files)) {
      if (c === null) rmSync(join(sisterDir, f), { force: true });
      else writeFileSync(join(sisterDir, f), c, 'utf-8');
    }
    await sister.raw(['add', '-A']);
    await sister.commit('advance again');
    await sister.push('origin', 'main');
    return (await sister.revparse(['HEAD'])).trim();
  }

  test('an unresolved collision re-pins theirs to the latest tip on each pull', async () => {
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');
      const firstPin = engine.getConflicts()[0]?.theirsSha;
      expect(firstPin).toMatch(/^[0-9a-f]{40}$/);

      // Origin re-edits the same conflicting line; the collision persists.
      const tip2 = await advanceOriginFrom({ 'a.md': 'ORIGIN1b\nline2\n' });
      await engine.trigger('pull');

      const conflicts = engine.getConflicts();
      expect(conflicts).toHaveLength(1);
      // theirs re-pinned to the new tip's blob (resolver never shows stale content).
      expect(conflicts[0]?.theirsSha).not.toBe(firstPin);
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(tip2);
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a collision auto-dissolves when upstream converges to the local overlay', async () => {
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');
      expect(engine.getConflicts()).toHaveLength(1);

      // Upstream moves to match the local overlay — the collision disappears.
      const tip2 = await advanceOriginFrom({ 'a.md': 'LOCAL1\nline2\n' });
      await engine.trigger('pull');

      expect(engine.getConflicts()).toEqual([]);
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(tip2);
      // Converged: file matches the tip, tree clean.
      expect(await listNames(simpleGit(projectDir), ['diff-index', '--name-only', 'HEAD'])).toEqual(
        [],
      );
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('notifies the resolved callback when a collision auto-dissolves', async () => {
    // onContentConflictsResolved is what clears an open document's conflict
    // lifecycle marker; a dropped or mis-pathed call leaves the conflict badge
    // stuck. Mirror of the auto-dissolve test, asserting the callback fires.
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const resolved: string[][] = [];
    const engine = makePullEngine({
      onContentConflictsResolved: (files) => {
        resolved.push([...files]);
      },
    });
    try {
      await engine.start();
      await engine.trigger('pull');
      expect(engine.getConflicts()).toHaveLength(1);

      // Upstream moves to match the local overlay — the collision dissolves.
      await advanceOriginFrom({ 'a.md': 'LOCAL1\nline2\n' });
      await engine.trigger('pull');

      expect(engine.getConflicts()).toEqual([]);
      expect(resolved).toEqual([['a.md']]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a fast-forward refusal restores the overlay bytes (mineRestore guard)', async () => {
    // The overlapping paths are reset to HEAD before the fast-forward; if the FF
    // then refuses (a divergence the ahead-check missed), mineRestore must put
    // the user's uncommitted bytes back rather than leave HEAD's version on disk.
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');
    const headBefore = (await simpleGit(projectDir).revparse(['HEAD'])).trim();

    const engine = makePullEngine();
    // Force the FF to refuse after the overlay was reset to HEAD — the TOCTOU
    // path where ahead === 0 at plan time but the FF still can't advance.
    const ffSpy = vi
      .spyOn(engine as unknown as { fastForwardOnly: () => Promise<unknown> }, 'fastForwardOnly')
      .mockResolvedValue({
        ok: false,
        refusal: 'divergence',
        stderr: '',
        exitCode: 128,
        timedOut: false,
      });
    try {
      await engine.start();
      const outcome = await engine.pullOnce();

      expect(ffSpy).toHaveBeenCalled();
      // The overlay bytes are restored — not silently replaced with HEAD.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      expect(outcome).toBe('refused');
      expect(engine.getStatus().pausedReason).toBe('diverged-local-commits');
      // The FF never happened, so HEAD stayed put.
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(headBefore);
    } finally {
      await engine.destroy();
    }
  });

  test('resolving take-theirs writes the tip version and clears the conflict without committing', async () => {
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');
      const tip = (await simpleGit(projectDir).revparse(['HEAD'])).trim();
      expect(engine.getConflicts()).toHaveLength(1);

      await engine.resolveConflict('a.md', 'theirs');

      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('ORIGIN1\nline2\n');
      expect(engine.getConflicts()).toEqual([]);
      // Branch unchanged (still at origin tip); resolution never commits.
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(tip);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('resolving keep-mine leaves the overlay and clears the conflict without committing', async () => {
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');
      const tip = (await simpleGit(projectDir).revparse(['HEAD'])).trim();

      await engine.resolveConflict('a.md', 'mine');

      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL1\nline2\n');
      expect(engine.getConflicts()).toEqual([]);
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(tip);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('a non-content overlap is never auto-committed in pull mode', async () => {
    // The merge-native path auto-resolves non-content conflicts with `--theirs`
    // and `git commit --no-edit`. Pull-only must never reach that commit: a
    // non-content overlap keeps the local edit with the branch exactly at the
    // origin tip (no extra commit).
    const { originTip } = await cloneBehindOrigin({
      seed: { '.mcp.json': '{"v":1}\n', 'a.md': 'A1\n' },
      advance: { '.mcp.json': '{"v":2}\n', 'a.md': 'A1\nA2\n' },
    });
    writeFileSync(join(projectDir, '.mcp.json'), '{"v":3}\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');

      const project = simpleGit(projectDir);
      // HEAD is exactly origin's tip — no auto-resolve commit was minted.
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, '.mcp.json'), 'utf-8')).toBe('{"v":3}\n');
      expect(engine.getConflicts()).toEqual([]);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('reconcileConflictsFromGit leaves working-tree conflicts intact', async () => {
    // The batch-end reconcile keys on MERGE_HEAD, which a working-tree conflict
    // never has — it must not wipe the pull-only overlay ledger.
    await cloneBehindOrigin({
      seed: { 'a.md': 'line1\nline2\n' },
      advance: { 'a.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nline2\n', 'utf-8');

    const engine = makePullEngine();
    try {
      await engine.start();
      await engine.trigger('pull');
      expect(engine.getConflicts()).toHaveLength(1);

      await engine.reconcileConflictsFromGit();
      expect(engine.getConflicts()).toHaveLength(1);
    } finally {
      await engine.destroy();
    }
  });

  test('a persisted working-tree conflict survives boot and keeps the engine idle', async () => {
    // A prior run left a working-tree conflict in conflicts.json. On restart the
    // engine must retain it (no MERGE_HEAD required) and stay idle — a paused
    // 'conflict' state would stop the follower pulling the rest of the repo.
    await cloneBehindOrigin({
      seed: { 'a.md': 'v1\n' },
      advance: { 'a.md': 'v1\nv2\n' },
    });
    const blob = (await simpleGit(projectDir).raw(['rev-parse', 'HEAD:a.md'])).trim();
    writeFileSync(
      join(okDir, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: [
          {
            file: 'a.md',
            detectedAt: new Date().toISOString(),
            variant: 'working-tree',
            theirsSha: blob,
            baseSha: blob,
          },
        ],
      }),
      'utf-8',
    );

    const engine = makePullEngine();
    try {
      await engine.start();
      expect(engine.getConflicts().map((c) => c.file)).toEqual(['a.md']);
      expect(engine.getStatus().state).toBe('idle');
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Pull-only mode transitions (stranded-commit conversion) ───────────────────
//
// Entering pull-only with local commits ahead of origin folds those commits into
// a working-tree overlay and realigns the branch: a `--mixed` reset moves the ref
// without touching the working tree, so on-screen content is byte-identical and
// nothing is committed on the user's behalf. These tests use real bare-origin +
// clone fixtures so the reset, fast-forward, and push all run for real.

describe('SyncEngine pull-only mode transitions', () => {
  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  /** Seed origin from a sister clone and clone it into projectDir. */
  async function seedAndClone(seed: Record<string, string>): Promise<{
    seedTip: string;
    bareDir: string;
    sister: ReturnType<typeof simpleGit>;
    sisterDir: string;
  }> {
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    for (const [f, c] of Object.entries(seed)) writeFileSync(join(sisterDir, f), c, 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');
    const seedTip = (await sister.revparse(['HEAD'])).trim();

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Follower');
    await project.raw('config', 'user.email', 'follower@test.com');
    return { seedTip, bareDir, sister, sisterDir };
  }

  async function advanceOrigin(
    sister: ReturnType<typeof simpleGit>,
    sisterDir: string,
    files: Record<string, string | null>,
  ): Promise<string> {
    for (const [f, c] of Object.entries(files)) {
      if (c === null) rmSync(join(sisterDir, f), { force: true });
      else writeFileSync(join(sisterDir, f), c, 'utf-8');
    }
    await sister.raw(['add', '-A']);
    await sister.commit('advance');
    await sister.push('origin', 'main');
    return (await sister.revparse(['HEAD'])).trim();
  }

  /** Commit local edits in projectDir, returning the new HEAD sha. */
  async function commitLocal(files: Record<string, string>, msg: string): Promise<string> {
    const project = simpleGit(projectDir);
    for (const [f, c] of Object.entries(files)) writeFileSync(join(projectDir, f), c, 'utf-8');
    await project.add('.');
    await project.commit(msg);
    return (await project.revparse(['HEAD'])).trim();
  }

  function makeEngineMode(
    mode: SyncMode,
    checkpoint?: (ctx: { branch: string; ahead: number }) => void | Promise<void>,
  ) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode,
      pullIntervalSeconds: 99999,
      pushIntervalSeconds: 99999,
      checkpointBeforeStrandedConversion: checkpoint,
    });
  }

  /** Poll until projectDir's HEAD reaches `sha` (event-driven, not a fixed wait). */
  async function waitForHead(sha: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const project = simpleGit(projectDir);
    while ((await project.revparse(['HEAD'])).trim() !== sha) {
      if (Date.now() > deadline) throw new Error(`HEAD did not reach ${sha} within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function assertNoGitResidue(): Promise<void> {
    expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(false);
    const stashList = await simpleGit(projectDir).raw(['stash', 'list']);
    expect(stashList.trim()).toBe('');
  }

  test('a failed stranded-commit conversion surfaces the divergence instead of a clean idle', async () => {
    await seedAndClone({ 'a.md': 'A1\n' });
    // Two committed-but-unpushed edits (ahead 2, behind 0).
    await commitLocal({ 'a.md': 'A1\nLOCAL2\n' }, 'local 1');
    await commitLocal({ 'a.md': 'A1\nLOCAL2\nLOCAL3\n' }, 'local 2');
    // A stale index.lock makes the `git reset --mixed` inside the conversion
    // fail. setMode still continues to idle + a scheduled pull, and the ahead-only
    // shape (behind 0) means that pull reports up-to-date without re-surfacing the
    // divergence — so the conversion failure itself must set a paused reason,
    // otherwise the badge shows a clean idle over unpushable stranded commits.
    writeFileSync(join(projectDir, '.git', 'index.lock'), '', 'utf-8');

    const engine = makeEngineMode('full');
    try {
      await engine.setMode('follow');
      expect(engine.getStatus().pausedReason).toBe('diverged-local-commits');
    } finally {
      rmSync(join(projectDir, '.git', 'index.lock'), { force: true });
      await engine.destroy();
    }
  });

  test('full→pull downgrade folds ahead-only commits into an overlay at origin tip', async () => {
    const { seedTip } = await seedAndClone({ 'a.md': 'A1\n' });
    // Two committed-but-unpushed edits: ahead 2, behind 0 (push access revoked).
    await commitLocal({ 'a.md': 'A1\nLOCAL2\n' }, 'local 1');
    const localTip = await commitLocal({ 'a.md': 'A1\nLOCAL2\nLOCAL3\n' }, 'local 2');

    const engine = makeEngineMode('full');
    try {
      await engine.setMode('follow');

      const project = simpleGit(projectDir);
      // Branch realigned to origin tip (the seed IS the merge base for ahead-only).
      expect((await project.revparse(['HEAD'])).trim()).toBe(seedTip);
      // Docs byte-identical: the committed content now rides as an overlay.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('A1\nLOCAL2\nLOCAL3\n');
      expect(await listNames(project, ['diff-index', '--name-only', 'HEAD'])).toEqual(['a.md']);
      // Zero local commits remain on the branch.
      expect((await project.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim()).toBe('0');
      // Recoverable in history: the reset left ORIG_HEAD at the pre-conversion tip.
      expect((await project.revparse(['ORIG_HEAD'])).trim()).toBe(localTip);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('enable-time divergence converts then fast-forwards to origin tip', async () => {
    // Local commit edits a.md (ahead 1); origin independently advanced b.md
    // (behind 1) — a true divergence. Conversion lands on the merge base with the
    // local edit as overlay; the next pull carries the branch to origin's tip and
    // brings the non-overlapping origin change.
    const { sister, sisterDir } = await seedAndClone({ 'a.md': 'A1\n', 'b.md': 'B1\n' });
    const originTip = await advanceOrigin(sister, sisterDir, { 'b.md': 'B1\nB2\n' });
    await commitLocal({ 'a.md': 'A1\nLOCAL\n' }, 'local edit');

    const engine = makeEngineMode('off');
    try {
      await engine.setMode('follow');
      await waitForHead(originTip);

      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      // Local edit survives as overlay; origin's non-overlapping change landed.
      expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('A1\nLOCAL\n');
      expect(readFileSync(join(projectDir, 'b.md'), 'utf-8')).toBe('B1\nB2\n');
      expect(await listNames(project, ['diff-index', '--name-only', 'HEAD'])).toEqual(['a.md']);
      expect((await project.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim()).toBe('0');
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('the checkpoint fires before the branch ref moves', async () => {
    const { seedTip } = await seedAndClone({ 'a.md': 'A1\n' });
    const localTip = await commitLocal({ 'a.md': 'A1\nLOCAL\n' }, 'local edit');

    let checkpointAhead = 0;
    let headAtCheckpoint: string | null = null;
    const engine = makeEngineMode('off', async ({ ahead }) => {
      checkpointAhead = ahead;
      // HEAD is still at the local tip when the checkpoint runs — the reset that
      // realigns the branch happens after, so the snapshot captures the stranded
      // content, not the post-reset state.
      headAtCheckpoint = (await simpleGit(projectDir).revparse(['HEAD'])).trim();
    });
    try {
      await engine.setMode('follow');

      expect(checkpointAhead).toBe(1);
      expect(headAtCheckpoint).toBe(localTip);
      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(seedTip);
    } finally {
      await engine.destroy();
    }
  });

  test('off→pull with no ahead commits enables plainly (no conversion)', async () => {
    const { seedTip } = await seedAndClone({ 'a.md': 'A1\n' });

    let checkpointCalled = false;
    const engine = makeEngineMode('off', () => {
      checkpointCalled = true;
    });
    try {
      await engine.setMode('follow');

      expect(checkpointCalled).toBe(false);
      // Branch untouched (no stranded commits to realign around).
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(seedTip);
      expect(engine.getStatus().syncMode).toBe('follow');
    } finally {
      await engine.destroy();
    }
  });

  test('off→full keeps ahead commits (full mode pushes them, never converts)', async () => {
    await seedAndClone({ 'a.md': 'A1\n' });
    const localTip = await commitLocal({ 'a.md': 'A1\nLOCAL\n' }, 'local edit');

    let checkpointCalled = false;
    const engine = makeEngineMode('off', () => {
      checkpointCalled = true;
    });
    try {
      await engine.setMode('full');

      // Full mode leaves the commits on the branch to push — no overlay conversion.
      expect(checkpointCalled).toBe(false);
      expect((await simpleGit(projectDir).revparse(['HEAD'])).trim()).toBe(localTip);
      await assertNoGitResidue();
    } finally {
      await engine.destroy();
    }
  });

  test('pull→full upgrade pushes the overlay content on the next cycle', async () => {
    const { bareDir } = await seedAndClone({ 'a.md': 'A1\n' });
    // A pull-only overlay: an uncommitted local edit riding on origin's tip.
    writeFileSync(join(projectDir, 'a.md'), 'A1\nOVERLAY\n', 'utf-8');

    const engine = makeEngineMode('follow');
    try {
      await engine.setMode('full');
      await engine.trigger('push');

      // The overlay was committed and pushed — origin now carries its content.
      const originContent = await simpleGit(bareDir).raw(['show', 'main:a.md']);
      expect(originContent).toBe('A1\nOVERLAY\n');
    } finally {
      await engine.destroy();
    }
  });

  test('probeUnpushedCommitCount reports the stranded count with and without an upstream', async () => {
    await seedAndClone({ 'a.md': 'A1\n' });
    await commitLocal({ 'a.md': 'A1\nL1\n' }, 'local 1');
    await commitLocal({ 'a.md': 'A1\nL1\nL2\n' }, 'local 2');

    const engine = makeEngineMode('off');
    try {
      // refreshRemote sets hasRemote without triggering a conversion (mode stays off).
      await engine.refreshRemote();
      expect(await engine.probeUnpushedCommitCount()).toBe(2);

      // With no configured upstream, the count comes from the rev-list fallback.
      await simpleGit(projectDir).raw(['branch', '--unset-upstream']);
      expect(await engine.probeUnpushedCommitCount()).toBe(2);
    } finally {
      await engine.destroy();
    }
  });
});

// ─── Fast-forward refusal classifier ───────────────────────────────────────────
//
// classifyFastForwardRefusal keys on git's exit code + stderr severity token.
// Both are version- and locale-sensitive, so these tests feed it the OUTPUT of
// a real `git merge --ff-only` against the shipped git build (LANG=C, matching
// the sync git env) rather than a hand-written string.

describe('classifyFastForwardRefusal (pinned against real git)', () => {
  async function realFfRefusal(): Promise<{ code: number | null; stderr: string }> {
    try {
      await execFileAsync(
        'git',
        ['-c', 'core.autocrlf=false', 'merge', '--ff-only', 'origin/main'],
        {
          cwd: projectDir,
          env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        },
      );
      throw new Error('expected fast-forward to refuse');
    } catch (e) {
      const err = e as { code?: number | string; stderr?: string };
      return {
        code: typeof err.code === 'number' ? err.code : null,
        stderr: typeof err.stderr === 'string' ? err.stderr : String(e),
      };
    }
  }

  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  async function cloneBehind(advance: string): Promise<void> {
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    writeFileSync(join(sisterDir, 'a.md'), 'l1\nl2\n', 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');
    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });
    writeFileSync(join(sisterDir, 'a.md'), advance, 'utf-8');
    await sister.add('.');
    await sister.commit('advance');
    await sister.push('origin', 'main');
    // The clone's origin/main still points at the seed until it fetches; update
    // it so the direct `git merge --ff-only origin/main` below sees the advance.
    await simpleGit(projectDir).fetch('origin');
  }

  test('an overlapping dirty edit classifies as overlay-overlap', async () => {
    await cloneBehind('ORIGIN1\nl2\n');
    // Local uncommitted edit to the same file the incoming tip changed.
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL1\nl2\n', 'utf-8');
    const { code, stderr } = await realFfRefusal();
    expect(code).toBe(1);
    expect(classifyFastForwardRefusal({ exitCode: code, stderr })).toBe('overlay-overlap');
  });

  test('diverged history classifies as divergence', async () => {
    await cloneBehind('ORIGIN1\nl2\n');
    const project = simpleGit(projectDir);
    await project.raw('config', 'user.name', 'Follower');
    await project.raw('config', 'user.email', 'follower@test.com');
    writeFileSync(join(projectDir, 'a.md'), 'LOCAL_COMMIT\nl2\n', 'utf-8');
    await project.add('.');
    await project.commit('local ahead');
    const { code, stderr } = await realFfRefusal();
    expect(code).toBe(128);
    expect(classifyFastForwardRefusal({ exitCode: code, stderr })).toBe('divergence');
  });
});

// ─── One-shot pull (op 'pull') ──────────────────────────────────────────────
//
// `trigger('pull')` (the spec-B contract) runs a single pull in every mode and
// records a bounded outcome. Unlike a background cycle it also runs for an
// off/null project — fetching + fast-forwarding via the B1 variant without ever
// committing or leaving the project enabled. Every path writes lastPullUtc +
// lastPullOutcome so a downstream surface can detect a fresh result by change.

describe("SyncEngine one-shot pull (op 'pull')", () => {
  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  /**
   * Seed origin from a sister clone, clone it into projectDir, then optionally
   * advance origin so the project is one commit behind. Returns origin's tip SHA
   * and the bare dir (so a caller can read origin's ref).
   */
  async function cloneFromOrigin(opts: {
    seed: Record<string, string>;
    advance?: Record<string, string>;
  }): Promise<{ originTip: string; bareDir: string }> {
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    for (const [f, c] of Object.entries(opts.seed)) writeFileSync(join(sisterDir, f), c, 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });

    if (opts.advance) {
      for (const [f, c] of Object.entries(opts.advance)) {
        writeFileSync(join(sisterDir, f), c, 'utf-8');
      }
      await sister.add('.');
      await sister.commit('advance');
      await sister.push('origin', 'main');
    }
    return { originTip: (await sister.revparse(['HEAD'])).trim(), bareDir };
  }

  function makeEngineFor(mode: SyncMode) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode,
    });
  }

  async function assertNoGitResidue(): Promise<void> {
    expect(existsSync(join(projectDir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await simpleGit(projectDir).raw(['stash', 'list'])).trim()).toBe('');
  }

  test('mode off: a one-shot pull fast-forwards without enabling the project', async () => {
    const { originTip, bareDir } = await cloneFromOrigin({
      seed: { 'doc.md': 'v1\n' },
      advance: { 'doc.md': 'v1\nv2\n' },
    });
    const originRefBefore = (await simpleGit(bareDir).revparse(['main'])).trim();

    const engine = makeEngineFor('off');
    try {
      await engine.start();
      expect(engine.getStatus().state).toBe('disabled');

      const outcome = await engine.pullOnce();

      expect(outcome).toBe('succeeded');
      const project = simpleGit(projectDir);
      expect((await project.revparse(['HEAD'])).trim()).toBe(originTip);
      expect(readFileSync(join(projectDir, 'doc.md'), 'utf-8')).toBe('v1\nv2\n');
      // Never enabled: mode stays off and the engine returns to its inactive
      // resting state instead of looking like a running sync.
      const status = engine.getStatus();
      expect(status.syncMode).toBe('off');
      expect(status.state).toBe('disabled');
      expect(status.lastPullOutcome).toBe('succeeded');
      expect(typeof status.lastPullUtc).toBe('string');
      // No commit made on the user's behalf (B1 variant) and no push to origin.
      await assertNoGitResidue();
      expect((await simpleGit(bareDir).revparse(['main'])).trim()).toBe(originRefBefore);
    } finally {
      await engine.destroy();
    }
  });

  test('an already-current project reports up-to-date', async () => {
    await cloneFromOrigin({ seed: { 'doc.md': 'v1\n' } }); // no advance — clone sits at tip
    const engine = makeEngineFor('follow');
    try {
      await engine.start();
      const outcome = await engine.pullOnce();
      expect(outcome).toBe('up-to-date');
      expect(typeof engine.getStatus().lastPullUtc).toBe('string');
    } finally {
      await engine.destroy();
    }
  });

  test('a same-line collision reports conflict', async () => {
    await cloneFromOrigin({
      seed: { 'doc.md': 'line1\nline2\n' },
      advance: { 'doc.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'doc.md'), 'LOCAL1\nline2\n', 'utf-8');
    const engine = makeEngineFor('follow');
    try {
      await engine.start();
      const outcome = await engine.pullOnce();
      expect(outcome).toBe('conflict');
      expect(engine.getStatus().conflictCount).toBe(1);
      expect(engine.getStatus().lastPullOutcome).toBe('conflict');
    } finally {
      await engine.destroy();
    }
  });

  test('a concurrent one-shot is refused (single-flight)', async () => {
    await cloneFromOrigin({
      seed: { 'doc.md': 'v1\n' },
      advance: { 'doc.md': 'v1\nv2\n' },
    });
    const engine = makeEngineFor('follow');
    try {
      await engine.start();
      // The first call holds the in-flight guard across its first await; the
      // second observes it and refuses without racing the working tree.
      const first = engine.pullOnce();
      const second = await engine.pullOnce();
      expect(second).toBe('refused');
      expect(await first).toBe('succeeded');
    } finally {
      await engine.destroy();
    }
  });

  test('an unreachable remote reports error-class', async () => {
    await cloneFromOrigin({ seed: { 'doc.md': 'v1\n' } });
    // Repoint origin at a nonexistent path so the fetch fails.
    await simpleGit(projectDir).raw(
      'config',
      'remote.origin.url',
      join(tmpDir, 'nonexistent-bare.git'),
    );
    const engine = makeEngineFor('follow');
    try {
      await engine.start();
      const outcome = await engine.pullOnce();
      expect(outcome).toBe('error');
      const status = engine.getStatus();
      expect(status.lastPullOutcome).toBe('error');
      expect(`${status.pullError ?? ''}${status.pullErrorCode ?? ''}`).not.toBe('');
    } finally {
      await engine.destroy();
    }
  });

  test("trigger('pull') records the outcome in status", async () => {
    await cloneFromOrigin({
      seed: { 'doc.md': 'v1\n' },
      advance: { 'doc.md': 'v1\nv2\n' },
    });
    const engine = makeEngineFor('follow');
    try {
      await engine.start();
      await engine.trigger('pull');
      const status = engine.getStatus();
      expect(status.lastPullOutcome).toBe('succeeded');
      expect(typeof status.lastPullUtc).toBe('string');
    } finally {
      await engine.destroy();
    }
  });

  test('lastPullUtc is null before the first pull and set after (change-detection)', async () => {
    await cloneFromOrigin({
      seed: { 'doc.md': 'v1\n' },
      advance: { 'doc.md': 'v1\nv2\n' },
    });
    const engine = makeEngineFor('off');
    try {
      await engine.start();
      expect(engine.getStatus().lastPullUtc).toBeNull();
      expect(engine.getStatus().lastPullOutcome).toBeNull();
      await engine.pullOnce();
      expect(engine.getStatus().lastPullUtc).not.toBeNull();
      expect(engine.getStatus().lastPullOutcome).toBe('succeeded');
    } finally {
      await engine.destroy();
    }
  });

  test('refuses when there is no remote', async () => {
    // A repo with commits but no origin — nothing to pull from.
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Solo');
    await git.raw('config', 'user.email', 'solo@test.com');
    writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
    await git.add('.');
    await git.commit('seed');
    const engine = makeEngineFor('off');
    try {
      await engine.start();
      const outcome = await engine.pullOnce();
      expect(outcome).toBe('refused');
      expect(engine.getStatus().lastPullOutcome).toBe('refused');
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine telemetry', () => {
  async function seedBareOrigin(): Promise<string> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await simpleGit(bareDir).raw('symbolic-ref', 'HEAD', 'refs/heads/main');
    return bareDir;
  }

  async function cloneFromOrigin(opts: {
    seed: Record<string, string>;
    advance?: Record<string, string>;
  }): Promise<void> {
    const bareDir = await seedBareOrigin();
    const sisterDir = join(tmpDir, 'sister');
    mkdirSync(sisterDir, { recursive: true });
    const sister = simpleGit(sisterDir);
    await sister.init(['--initial-branch=main']);
    await sister.raw('config', 'user.name', 'Sister');
    await sister.raw('config', 'user.email', 'sister@test.com');
    for (const [f, c] of Object.entries(opts.seed)) writeFileSync(join(sisterDir, f), c, 'utf-8');
    await sister.add('.');
    await sister.commit('seed');
    await sister.addRemote('origin', bareDir);
    await sister.push('origin', 'main');

    rmSync(projectDir, { recursive: true, force: true });
    await simpleGit(tmpDir).clone(bareDir, projectDir);
    mkdirSync(okDir, { recursive: true });

    if (opts.advance) {
      for (const [f, c] of Object.entries(opts.advance)) {
        writeFileSync(join(sisterDir, f), c, 'utf-8');
      }
      await sister.add('.');
      await sister.commit('advance');
      await sister.push('origin', 'main');
    }
  }

  function makeEngineFor(mode: SyncMode) {
    return new SyncEngine({
      projectDir,
      contentDir: projectDir,
      contentFilter: stubContentFilter,
      mode,
    });
  }

  test('setMode logs the mode change with its source', async () => {
    await cloneFromOrigin({ seed: { 'doc.md': 'v1\n' } });
    const engine = makeEngineFor('off');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.setMode('full', 'committed-default');
      const entry = cap.entries.find((e) => e.msg === '[sync] mode changed');
      expect(entry).toBeDefined();
      expect(entry?.data).toMatchObject({ from: 'off', to: 'full', source: 'committed-default' });
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  test('an unchanged setMode emits no mode-change log', async () => {
    await cloneFromOrigin({ seed: { 'doc.md': 'v1\n' } });
    const engine = makeEngineFor('follow');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.setMode('follow'); // same value — idempotent early-return
      expect(cap.entries.some((e) => e.msg === '[sync] mode changed')).toBe(false);
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  test('a one-shot pull logs its mode and outcome on success', async () => {
    await cloneFromOrigin({ seed: { 'doc.md': 'v1\n' }, advance: { 'doc.md': 'v1\nv2\n' } });
    const engine = makeEngineFor('off');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.pullOnce();
      const entry = cap.entries.find((e) => e.msg === '[sync] one-shot pull complete');
      expect(entry).toBeDefined();
      expect(entry?.data).toMatchObject({ mode: 'off', outcome: 'succeeded' });
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  test('a refused one-shot pull still logs the refused outcome', async () => {
    // No remote: the one-shot refuses rather than silently no-op'ing.
    const engine = makeEngineFor('off');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.pullOnce();
      const entry = cap.entries.find((e) => e.msg === '[sync] one-shot pull complete');
      expect(entry?.data).toMatchObject({ mode: 'off', outcome: 'refused' });
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  test('a B1 pull logs conflict-lifecycle counts and the overlay-stock gauge', async () => {
    await cloneFromOrigin({
      seed: { 'docA.md': 'line1\nline2\n', 'docB.md': 'b1\nb2\nb3\n', 'docC.md': 'c\n' },
      advance: { 'docA.md': 'ORIGIN1\nline2\n', 'docB.md': 'b1\nb2\nORIGIN3\n' },
    });
    // Three local overlays: a same-line collision (docA — line1 both sides), a
    // different-line auto-combine (docB — local line1, origin line3, unchanged
    // line2 anchoring the merge), and a non-overlapping local-only edit (docC)
    // that rides through the fast-forward.
    writeFileSync(join(projectDir, 'docA.md'), 'LOCAL1\nline2\n', 'utf-8');
    writeFileSync(join(projectDir, 'docB.md'), 'LOCAL1\nb2\nb3\n', 'utf-8');
    writeFileSync(join(projectDir, 'docC.md'), 'c\nlocal-extra\n', 'utf-8');
    const engine = makeEngineFor('follow');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.pullOnce();
      const entry = cap.entries.find(
        (e) => e.msg === '[sync] pull-only: fast-forwarded to origin tip',
      );
      expect(entry).toBeDefined();
      expect(entry?.data).toMatchObject({
        created: 1,
        autoCombined: 1,
        autoDissolved: 0,
        overlayStock: 3,
      });
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });

  test('resolving a working-tree conflict logs the chosen strategy', async () => {
    await cloneFromOrigin({
      seed: { 'doc.md': 'line1\nline2\n' },
      advance: { 'doc.md': 'ORIGIN1\nline2\n' },
    });
    writeFileSync(join(projectDir, 'doc.md'), 'LOCAL1\nline2\n', 'utf-8');
    const engine = makeEngineFor('follow');
    const cap = captureSyncLogs();
    try {
      await engine.start();
      await engine.pullOnce(); // same-line collision → working-tree conflict entry
      expect(engine.getStatus().conflictCount).toBe(1);
      await engine.resolveConflict('doc.md', 'theirs');
      const entry = cap.entries.find(
        (e) => e.msg === '[sync] pull-only: conflict resolved by choice',
      );
      expect(entry).toBeDefined();
      expect(entry?.data).toMatchObject({ choice: 'theirs' });
    } finally {
      cap.restore();
      await engine.destroy();
    }
  });
});
