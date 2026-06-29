import { describe as _bunDescribe, afterEach, beforeEach, expect, test } from 'bun:test';

const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { classifyGitError } from './error-classification.ts';
import type { DetectGhFn } from './github-permissions.ts';
import type { SyncState } from './sync-engine.ts';
import { SyncEngine } from './sync-engine.ts';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

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

async function waitForPushPermissionResolved(engine: SyncEngine, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (engine.getStatus().pushPermission === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`push-permission probe did not resolve within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

describe('SyncEngine state persistence round-trip', () => {
  const statePath = () => join(okDir, 'sync-state.json');

  test('saveStateNow via destroy() writes sync-state.json', async () => {
    const engine = makeEngine();
    await engine.destroy(); // triggers saveStateNow() inside stop()
    expect(existsSync(statePath())).toBe(true);
  });

  test('sync-state.json does not persist the config-owned enabled preference', async () => {
    const engine = makeEngine({ syncEnabled: true });
    await engine.destroy();
    const persisted = JSON.parse(readFileSync(statePath(), 'utf-8')) as Record<string, unknown>;
    expect(persisted.syncEnabled).toBeUndefined();
  });

  test('restores consecutiveFailures from disk on start()', async () => {
    const persisted = {
      version: 1,
      lastSyncUtc: null,
      lastFetchUtc: null,
      lastPushedSha: null,
      consecutiveFailures: 4,
      inflightConflicts: [],
    };
    writeFileSync(statePath(), JSON.stringify(persisted), 'utf-8');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
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

  async function setupRealMergeConflict(files: string[]): Promise<void> {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    for (const f of files) {
      const dir = join(projectDir, f, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(projectDir, f), 'base\n', 'utf-8');
    }
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('feature');
    for (const f of files) writeFileSync(join(projectDir, f), 'feature\n', 'utf-8');
    await git.add('.');
    await git.commit('feature changes');
    await git.checkout('main');
    for (const f of files) writeFileSync(join(projectDir, f), 'main\n', 'utf-8');
    await git.add('.');
    await git.commit('main changes');
    try {
      await git.merge(['feature']);
    } catch {}
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    await git.addRemote('origin', bareDir);
  }

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
      expect(status.conflictCount).toBe(2);
      expect(status.state).toBe('conflict');
    } finally {
      await engine.destroy();
    }
  });

  test('clears stale conflicts.json when MERGE_HEAD is gone (user resolved externally)', async () => {
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

  test('reconciles partial external resolve against git unmerged index', async () => {
    const files = ['docs/a.md', 'docs/b.md'];
    await setupRealMergeConflict(files);

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

describe('SyncEngine ConflictStore admission (content-only)', () => {
  async function setupDivergence(remoteAction: 'modify' | 'delete'): Promise<void> {
    const bareDir = join(tmpDir, 'bare.git');
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);

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
      expect(status.conflictCount).toBe(0);
      expect(status.state).toBe('idle');
      expect(status.pausedReason).toBe('non-content-merge-failure');
      expect(status.pullError ?? '').toContain('.mcp.json');
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

describe('SyncEngine no-remote detection', () => {
  test('stays dormant if project dir has no git remote (no .git/)', async () => {
    const engine = makeEngine();
    await engine.start();
    expect(engine.getStatus().state).toBe('dormant');
    expect(engine.getStatus().hasRemote).toBe(false);
  });
});

describe('SyncEngine refreshRemote()', () => {
  test('is a no-op when hasRemote is already true', async () => {
    const git = simpleGit(projectDir);
    await git.init();
    await git.addRemote('origin', 'https://example.invalid/repo.git');

    const states: SyncState[] = [];
    const engine = makeEngine({ syncEnabled: false, onStateChange: (s) => states.push(s) });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(true);
    expect(engine.getStatus().state).toBe('disabled');

    const callsBefore = states.length;
    await engine.refreshRemote();
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

    await git.addRemote('origin', 'https://example.invalid/repo.git');

    await engine.refreshRemote();

    expect(engine.getStatus().hasRemote).toBe(true);
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
    expect(engine.getStatus().state).toBe('idle');
    expect(states).toContain('idle');

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
    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    await expect(engine.refreshRemote()).resolves.toBeUndefined();
    expect(engine.getStatus().hasRemote).toBe(false);
  });
});

describe('SyncEngine setEnabled() — unconditional remote re-probe', () => {
  test('setEnabled(true) demotes to dormant when remote was removed since boot', async () => {
    const git = simpleGit(projectDir);
    await git.init();
    await git.addRemote('origin', 'https://example.invalid/repo.git');

    const engine = makeEngine({ syncEnabled: false });
    await engine.start();
    expect(engine.getStatus().hasRemote).toBe(true);
    expect(engine.getStatus().state).toBe('disabled');

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

describe('SyncEngine updateCurrentBranch()', () => {
  test('transitions to disabled when branch is null (detached HEAD)', () => {
    const states: SyncState[] = [];
    const engine = makeEngine({ onStateChange: (s) => states.push(s) });
    engine.updateCurrentBranch(null); // no-op when dormant
    expect(engine.getStatus().state).toBe('dormant');
    expect(states).toEqual([]);
  });
});

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
    await engine.trigger();
    expect(engine.getStatus().consecutiveFailures).toBe(0);
  });
});

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

describe('SyncEngine push cycle pushes existing commits when local is ahead of origin', () => {
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

describe('SyncEngine per-operation error isolation', () => {
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

    await git.raw('config', 'remote.origin.pushurl', join(tmpDir, 'nonexistent-bare.git'));

    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nlocal change\n');
    await git.add('.');
    await git.commit('local commit');

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();
      await engine.trigger('sync');

      const status = engine.getStatus();
      expect(status.pushError ?? '').not.toBe('');
      expect(status.lastFetchUtc).not.toBeNull();
      expect(status.pullError).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });

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
    await git.push(['--set-upstream', 'origin', 'main']);
    await git.raw('config', 'remote.origin.url', join(tmpDir, 'nonexistent-bare.git'));
    await git.raw('config', 'remote.origin.pushurl', bareDir);

    writeFileSync(join(projectDir, 'README.md'), '# Test\n\nlocal change\n');
    await git.add('.');
    await git.commit('local commit');
    const head = (await git.revparse(['HEAD'])).trim();

    const engine = makeEngine({ syncEnabled: true });
    try {
      await engine.start();

      await engine.trigger('pull');
      const afterPull = engine.getStatus();
      expect(afterPull.pullError ?? '').not.toBe('');
      expect(afterPull.pushError).toBeUndefined();

      await engine.trigger('push');
      const afterPush = engine.getStatus();
      const remoteAfter = (await simpleGit(bareDir).revparse(['main'])).trim();
      expect(remoteAfter).toBe(head);
      expect(afterPush.lastPushedSha).toBe(head);
      expect(afterPush.pullError ?? '').not.toBe('');
    } finally {
      await engine.destroy();
    }
  });
});

describe('SyncEngine push-permission probe', () => {
  test('does NOT run when there is no remote', async () => {
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    await engine.start();
    expect(probe.calls).toBe(0);
    expect(engine.getStatus().pushPermission).toBeUndefined();
  });

  test('does NOT run for a non-github origin (gitlab, self-hosted) — emits unknown', async () => {
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
    expect(engine.getStatus().pushPermission).toEqual({
      checkStatus: 'unknown',
      unknownError: 'network',
    });
  });

  test('pushPermission is omitted from status before the probe resolves', () => {
    const probe = fakeProbe({ kind: 'allowed' });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: probe.fn });
    expect(engine.getStatus().pushPermission).toBeUndefined();
  });

  test('FR7: pushPermission is absent during the probe window (cold-start latency)', async () => {
    await initGitWithOrigin();
    let resolveProbe: (p: import('./github-permissions.ts').PushPermission) => void = () => {};
    const slowProbe: FakeProbeRecorder['fn'] = () =>
      new Promise((res) => {
        resolveProbe = res;
      });
    const engine = makeProbeEngine({ syncEnabled: false, fakeProbe: slowProbe });
    await engine.start();
    expect(engine.getStatus().pushPermission).toBeUndefined();
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
    expect(status.pushPermission?.checkStatus).toBe('unknown');
    expect(status.pushPermission?.checkStatus).not.toBe('denied');
  });

  test('FR7: transitioning idle → fetching during probe window does NOT set no-push-permission pausedReason', async () => {
    await initGitWithOrigin();
    let resolveProbe: (p: import('./github-permissions.ts').PushPermission) => void = () => {};
    const slowProbe: FakeProbeRecorder['fn'] = () =>
      new Promise((res) => {
        resolveProbe = res;
      });
    const engine = makeProbeEngine({ syncEnabled: true, fakeProbe: slowProbe });
    await engine.start();
    expect(engine.getStatus().state).toBe('idle');
    expect(engine.getStatus().pausedReason).not.toBe('no-push-permission');
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
    expect(status.state).toBe('dormant');
    await engine.destroy();
  });

  test('notifyCredentialsChanged is a no-op when sync is disabled', async () => {
    const engine = makeEngine({ syncEnabled: false });
    (engine as unknown as InternalState).pausedReason = 'auth-error';
    await engine.notifyCredentialsChanged();
    expect(engine.getStatus().pausedReason).toBe('auth-error');
  });

  test('notifyCredentialsChanged is a no-op when not parked on auth-error', async () => {
    const engine = makeEngine({ syncEnabled: true });
    const before = engine.getStatus().state;
    await engine.notifyCredentialsChanged();
    expect(engine.getStatus().state).toBe(before);
  });
});

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

    internal.gitHandle();
    internal.gitHandle();
    expect(detect.calls()).toBe(1);

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
