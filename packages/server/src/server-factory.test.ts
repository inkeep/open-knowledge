import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  LOCAL_DIR,
  lintDocument,
  REMOVED_KEYS,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { parseCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { MAX_AGENT_SESSIONS } from './agent-sessions.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { getBootTimings, resetBootTimingsForTest, startBootTimings } from './boot-timings.ts';
import { updateGeneratedIndexGitAttributes } from './content/generated-index-git-attributes.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import { classifyGitError } from './error-classification.ts';
import { applyExternalChange } from './external-change.ts';
import type {
  CheckPushPermissionOptions,
  DetectGhAccountsFn,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { buildIngressPolicy } from './ingress-policy.ts';
import { getLogger, loggerFactory, type PinoLogger } from './logger.ts';
import {
  createManagedRenameRecoveryJournal,
  managedRenameJournalPath,
  writeManagedRenameJournal,
} from './managed-rename-journal.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { ensureProjectGit } from './project-git.ts';
import { MAX_LCS_CELLS } from './reconciliation.ts';
import { saveRemovedDocsJournal } from './removed-docs-journal.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { releaseServerLock } from './server-lock.ts';
import {
  initShadowRepo,
  listRescueCheckpoints,
  type ShadowHandle,
  shadowGit,
} from './shadow-repo.ts';
import { TagIndex } from './tag-index.ts';
import { contentHash } from './version-hash.ts';

const watcherStartupFailures = vi.hoisted(() => ({ file: false, head: false }));

vi.mock('./file-watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-watcher.ts')>();
  return {
    ...actual,
    startWatcher: async (...args: Parameters<typeof actual.startWatcher>) => {
      if (watcherStartupFailures.file) {
        throw new Error('injected file-watcher startup failure');
      }
      return actual.startWatcher(...args);
    },
  };
});

vi.mock('./head-watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./head-watcher.ts')>();
  return {
    ...actual,
    startHeadWatcher: async (...args: Parameters<typeof actual.startHeadWatcher>) => {
      if (watcherStartupFailures.head) {
        throw new Error('injected head-watcher startup failure');
      }
      return actual.startHeadWatcher(...args);
    },
  };
});

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
  payload: Record<string, unknown>;
}

class CaptureLogger {
  readonly entries: LogEntry[] = [];

  info(data: unknown, message: string): void {
    this.entries.push({
      level: 'info',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  warn(data: unknown, message: string): void {
    this.entries.push({
      level: 'warn',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  error(data: unknown, message: string): void {
    this.entries.push({
      level: 'error',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }

  debug(data: unknown, message: string): void {
    this.entries.push({
      level: 'debug',
      msg: message,
      payload: (data as Record<string, unknown>) ?? {},
    });
  }
}

const captureLoggers = new Map<string, CaptureLogger>();

function captureAllLoggers(): {
  getCalls: (level?: string, msgContains?: string) => LogEntry[];
  getLoggerEntries: (name: string) => LogEntry[];
  reset: () => void;
} {
  captureLoggers.clear();
  loggerFactory.configure({
    loggerFactory: (name: string) => {
      const capture = new CaptureLogger();
      captureLoggers.set(name, capture);
      return capture as unknown as PinoLogger;
    },
  });

  return {
    getCalls(level?: string, msgContains?: string) {
      const all: LogEntry[] = [];
      for (const logger of captureLoggers.values()) {
        all.push(...logger.entries);
      }
      return all.filter((e) => {
        if (level && e.level !== level) return false;
        if (msgContains && !e.msg.includes(msgContains)) return false;
        return true;
      });
    },
    getLoggerEntries(name: string) {
      return captureLoggers.get(name)?.entries ?? [];
    },
    reset() {
      captureLoggers.clear();
    },
  };
}

describe('createServer() — document durability state isolation', () => {
  test('keeps same-named documents, branch scope, batch state, and disk intake per server', async () => {
    const projectA = await mkdtemp(join(tmpdir(), 'ok-durability-a-'));
    const projectB = await mkdtemp(join(tmpdir(), 'ok-durability-b-'));
    const docName = 'same-doc';
    const diskA = '# Disk A\n';
    const diskB = '# Disk B\n';
    let serverA: ServerInstance | null = null;
    let serverB: ServerInstance | null = null;
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');

    try {
      writeFileSync(join(projectA, `${docName}.md`), diskA, 'utf-8');
      writeFileSync(join(projectB, `${docName}.md`), diskB, 'utf-8');
      serverA = createServer({
        contentDir: projectA,
        projectDir: projectA,
        gitEnabled: false,
        quiet: true,
      });
      serverB = createServer({
        contentDir: projectB,
        projectDir: projectB,
        gitEnabled: false,
        quiet: true,
      });
      await Promise.all([serverA.ready, serverB.ready]);

      expect(beginStartup).toHaveBeenCalledTimes(2);
      expect(beginStartup.mock.instances[0]).not.toBe(beginStartup.mock.instances[1]);
      const [connectionA, connectionB] = await Promise.all([
        serverA.hocuspocus.openDirectConnection(docName),
        serverB.hocuspocus.openDirectConnection(docName),
      ]);

      expect(serverA.durabilityState).not.toBe(serverB.durabilityState);
      expect(serverA.durabilityState.getReconciledBase(docName)).toBe(diskA);
      expect(serverB.durabilityState.getReconciledBase(docName)).toBe(diskB);
      expect(serverA.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(diskA);
      expect(serverB.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(diskB);

      serverA.durabilityState.switchReconciledBaseScope('feature-a');
      serverA.durabilityState.setReconciledBase(docName, 'A feature');
      serverA.durabilityState.setBatchInProgress(true);
      serverA.durabilityState.beginInFlightFlush(docName, 'A flush');

      expect(serverA.durabilityState.getReconciledBase(docName)).toBe('A feature');
      expect(serverB.durabilityState.getActiveBranch()).toBe('main');
      expect(serverB.durabilityState.getReconciledBase(docName)).toBe(diskB);
      expect(serverA.durabilityState.isBatchInProgress()).toBe(true);
      expect(serverB.durabilityState.isBatchInProgress()).toBe(false);
      expect(serverB.durabilityState.peekInFlightFlush(docName)).toBeUndefined();

      const externalA = '# External A\n';
      applyExternalChange(serverA.durabilityState, serverA.hocuspocus, docName, externalA);

      expect(serverA.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(
        externalA,
      );
      expect(serverA.durabilityState.getReconciledBase(docName)).toBe(externalA);
      expect(serverB.hocuspocus.documents.get(docName)?.getText('source').toString()).toBe(diskB);
      expect(serverB.durabilityState.getReconciledBase(docName)).toBe(diskB);

      await Promise.all([connectionA.disconnect(), connectionB.disconnect()]);
    } finally {
      await serverA?.destroy();
      await serverB?.destroy();
      await Promise.all([
        rm(projectA, { recursive: true, force: true }),
        rm(projectB, { recursive: true, force: true }),
      ]);
      beginStartup.mockRestore();
    }
  });
});

describe('createServer() — agent-session cap passthrough', () => {
  let projectDir: string;
  let server: ServerInstance | null;

  beforeEach(() => {
    projectDir = mkdtempSync(resolve(tmpdir(), 'ok-agent-session-cap-'));
    server = null;
  });

  afterEach(async () => {
    await server?.destroy();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('installs the overridden session cap on the manager', async () => {
    const contentDir = mkdtempSync(resolve(projectDir, 'content-'));
    server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      agentSessionOptions: { maxSessions: 4, minEvictableIdleMs: 0 },
    });
    await server.ready;

    expect(server.sessionManager.sessionLimit).toBe(4);
  });

  test('defaults to MAX_AGENT_SESSIONS when no override is supplied', async () => {
    const contentDir = mkdtempSync(resolve(projectDir, 'content-'));
    server = createServer({
      contentDir,
      projectDir,
      quiet: true,
    });
    await server.ready;

    expect(server.sessionManager.sessionLimit).toBe(MAX_AGENT_SESSIONS);
  });
});

describe('createServer() — derived-index branch lifecycle', () => {
  let projectDir: string;
  let git: ReturnType<typeof simpleGit>;
  let server: ServerInstance | null;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ok-derived-branch-'));
    git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    writeFileSync(join(projectDir, 'main.md'), '# Main\n\n#main-branch\n', 'utf-8');
    await git.add('.');
    await git.commit('main content');
    await git.checkoutLocalBranch('feature');
    unlinkSync(join(projectDir, 'main.md'));
    writeFileSync(join(projectDir, 'feature.md'), '# Feature\n\n#feature-branch\n', 'utf-8');
    await git.add(['-A']);
    await git.commit('feature content');
    await git.checkout('main');
    server = null;
  });

  afterEach(async () => {
    await server?.destroy();
    vi.restoreAllMocks();
    await rm(projectDir, { recursive: true, force: true });
  });

  test('settles target indexes before broadcasting branch-switched', async () => {
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');
    server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      gitEnabled: false,
      skipStateManifestCheck: true,
    });
    await server.ready;
    const coordinator = beginStartup.mock.instances[0] as DerivedDocumentIndex;
    beginStartup.mockRestore();
    const settle = vi.spyOn(DerivedDocumentIndex.prototype, 'settleBranchFromDisk');
    const batchStatesAtBroadcast: boolean[] = [];
    const broadcast = server.cc1Broadcaster.emitBranchSwitched.bind(server.cc1Broadcaster);
    const emit = vi
      .spyOn(server.cc1Broadcaster, 'emitBranchSwitched')
      .mockImplementation((branch) => {
        batchStatesAtBroadcast.push(server.durabilityState.isBatchInProgress());
        broadcast(branch);
      });

    await git.checkout('feature');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('feature'), {
      timeout: 10_000,
      interval: 25,
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0] ?? 0);
    expect(batchStatesAtBroadcast).toEqual([false]);
    expect(await coordinator.getDocsForTagWithMatches('feature-branch')).toEqual([
      { docName: 'feature', matchingTags: ['feature-branch'] },
    ]);
    expect(await coordinator.getDocsForTagWithMatches('main-branch')).toEqual([]);
  }, 20_000);

  test('aborts a degraded branch settlement and releases coordinator queries', async () => {
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');
    server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      gitEnabled: false,
      skipStateManifestCheck: true,
    });
    await server.ready;
    const coordinator = beginStartup.mock.instances[0] as DerivedDocumentIndex;
    beginStartup.mockRestore();
    vi.spyOn(DerivedDocumentIndex.prototype, 'settleBranchFromDisk').mockRejectedValueOnce(
      new Error('injected branch settlement failure'),
    );
    const abort = vi.spyOn(DerivedDocumentIndex.prototype, 'abortBranchSwitch');
    const batchStatesAtBroadcast: boolean[] = [];
    const broadcast = server.cc1Broadcaster.emitBranchSwitched.bind(server.cc1Broadcaster);
    const emit = vi
      .spyOn(server.cc1Broadcaster, 'emitBranchSwitched')
      .mockImplementation((branch) => {
        batchStatesAtBroadcast.push(server.durabilityState.isBatchInProgress());
        broadcast(branch);
      });

    await git.checkout('feature');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('feature'), {
      timeout: 10_000,
      interval: 25,
    });

    expect(abort).toHaveBeenCalled();
    expect(batchStatesAtBroadcast).toEqual([false]);
    await expect(coordinator.getIndexedDocNames()).resolves.toBeInstanceOf(Array);
  }, 20_000);

  test('begin-branch failure always restores durability admission and releases queries', async () => {
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');
    server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      gitEnabled: false,
      skipStateManifestCheck: true,
    });
    await server.ready;
    const coordinator = beginStartup.mock.instances[0] as DerivedDocumentIndex;
    beginStartup.mockRestore();
    let rejectBegin!: (error: Error) => void;
    const beginBranch = vi
      .spyOn(DerivedDocumentIndex.prototype, 'beginBranchSwitch')
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectBegin = reject;
          }),
      );
    const abort = vi.spyOn(DerivedDocumentIndex.prototype, 'abortBranchSwitch');

    await git.checkout('feature');
    await vi.waitFor(() => expect(beginBranch).toHaveBeenCalledWith('feature'), {
      timeout: 10_000,
      interval: 25,
    });
    expect(server.durabilityState.isBatchInProgress()).toBe(true);

    rejectBegin(new Error('injected branch begin failure'));
    await vi.waitFor(
      () => {
        expect(abort).toHaveBeenCalled();
        expect(server?.durabilityState.isBatchInProgress()).toBe(false);
      },
      { timeout: 10_000, interval: 25 },
    );
    await expect(coordinator.getIndexedDocNames()).resolves.toBeInstanceOf(Array);
  }, 20_000);
});

async function executePendingStore(server: ServerInstance, docName: string): Promise<void> {
  const debounceId = `onStoreDocument-${docName}`;
  await vi.waitFor(() => expect(server.hocuspocus.debouncer.isDebounced(debounceId)).toBe(true), {
    timeout: 15_000,
    interval: 25,
  });
  const pending = server.hocuspocus.debouncer.executeNow(debounceId);
  if (pending) await pending.catch(() => undefined);
}

describe('createServer().destroy() — graceful shutdown flush', () => {
  let tmpDir: string;
  let logCapture: ReturnType<typeof captureAllLoggers>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-destroy-test-'));
    logCapture = captureAllLoggers();
  });

  afterEach(async () => {
    loggerFactory.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('flushes L1 markdown writes before destroy() resolves + emits shutdown log', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'hello world\n');
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const onDisk = await readFile(join(tmpDir, 'test-doc.md'), 'utf-8');
    expect(onDisk).toContain('hello world');

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBeGreaterThanOrEqual(1);

    const warnShutdownLogs = logCapture.getCalls('warn', 'shutdown');
    expect(warnShutdownLogs).toHaveLength(0);
  });

  test('flushes L2 git commit after L1 drain', async () => {
    const { mkdirSync } = await import('node:fs');
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      debounce: 60_000,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-doc-2');
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'commit me\n');
    });

    const doc = server.hocuspocus.documents.get('test-doc-2');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(shadowHandle);
    const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
    expect(wipRefs).toBeTruthy();
  });

  test('shutdown order: lock release happens AFTER L1 disk flush completes', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    const docName = 'shutdown-order';
    const contentPath = join(tmpDir, `${docName}.md`);
    const captures: Array<{ lockExists: boolean; contentOnDisk: boolean; payload: string }> = [];

    server.hocuspocus.configuration.extensions.push({
      async afterUnloadDocument(payload: { documentName: string }) {
        if (payload.documentName !== docName) return;
        captures.push({
          lockExists: existsSync(lockPath),
          contentOnDisk: existsSync(contentPath),
          payload: existsSync(contentPath) ? readFileSync(contentPath, 'utf-8') : '',
        });
      },
    });

    const conn = await server.hocuspocus.openDirectConnection(docName);
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'order-marker\n');
    });
    const doc = server.hocuspocus.documents.get(docName);
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    expect(existsSync(lockPath)).toBe(true);
    await server.destroy();

    expect(captures.length).toBe(1);
    expect(captures[0]?.lockExists).toBe(true);
    expect(captures[0]?.contentOnDisk).toBe(true);
    expect(captures[0]?.payload).toContain('order-marker');

    expect(existsSync(lockPath)).toBe(true);
    const postDestroyLock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(postDestroyLock.pid).toBe(process.pid);
    expect(postDestroyLock.draining).toBe(true);
    expect(readFileSync(contentPath, 'utf-8')).toContain('order-marker');
  });

  test('destroy() completes within destroyTimeoutMs AND rescues hung docs when onStoreDocument throws', async () => {
    const { mkdirSync } = await import('node:fs');
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      destroyTimeoutMs: 500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    server.hocuspocus.configuration.extensions.push({
      async onStoreDocument() {
        throw new Error('simulated store failure');
      },
    });

    const conn = await server.hocuspocus.openDirectConnection('pathological-doc');
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'will not be flushed\n');
    });

    const doc = server.hocuspocus.documents.get('pathological-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000);

    const warnLogs = logCapture.getCalls('warn', 'shutdown flushed');
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].payload.phaseErrors).toContainEqual(
      expect.objectContaining({
        phase: 'flush-all-stores',
        error: expect.stringContaining('timeout'),
      }),
    );

    const rescuePath = join(shadowHandle.gitDir, 'rescue', 'pathological-doc.md');
    expect(existsSync(rescuePath)).toBe(true);
    expect(readFileSync(rescuePath, 'utf-8')).toContain('will not be flushed');

    const phaseError = warnLogs[0].payload.phaseErrors as Array<{
      phase: string;
      error: string;
    }>;
    const flushErr = phaseError.find((e) => e.phase === 'flush-all-stores');
    expect(flushErr?.error).toContain('rescued [pathological-doc]');

    const rescueLogs = logCapture.getCalls('info', '[rescue]');
    expect(rescueLogs.length).toBeGreaterThanOrEqual(1);
    expect(rescueLogs[0].payload.docName).toBe('pathological-doc');
  });

  test('destroy() deliberately rescues and unloads a refused-store doc instead of stranding it to the timeout', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const docName = 'refused-store-doc';
    const initial = '# Refused store doc\n\nPersisted paragraph.\n';
    const docPath = join(contentDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');
    writeFileSync(join(projectDir, '.okignore'), `content/${docName}.md\n`, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    try {
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      chmodSync(docPath, 0o000);
      server.durabilityState.deleteReconciledBase(docName);

      const refusalsBefore = getMetrics().persistenceDuplicationBaselineRefusals;
      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph stranded at shutdown.\n');
      });
      await executePendingStore(server, docName);
      await vi.waitFor(
        () =>
          expect(serverDoc.getText('source').toString()).toContain(
            'Unflushed paragraph stranded at shutdown.',
          ),
        { timeout: 5_000, interval: 25 },
      );

      serverDoc.removeDirectConnection();
      const startedAt = Date.now();
      await server.destroy();
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(1_450);
      expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
        refusalsBefore + 1,
      );
      const flushPhaseErrors = logCapture
        .getCalls('warn', 'shutdown flushed')
        .flatMap((entry) => (entry.payload.phaseErrors as Array<{ phase: string }>) ?? []);
      expect(flushPhaseErrors.some((p) => p.phase === 'flush-all-stores')).toBe(false);
      expect(
        logCapture.getCalls('info', 'refused-store doc rescued and unloaded').length,
      ).toBeGreaterThanOrEqual(1);

      const rescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      expect(existsSync(rescuePath)).toBe(true);
      expect(readFileSync(rescuePath, 'utf-8')).toContain(
        'Unflushed paragraph stranded at shutdown.',
      );
    } finally {
      chmodSync(docPath, 0o644);
      await server.destroy();
    }
  });

  test('destroy() rescues a doc refused before shutdown that the unload loop would otherwise destroy', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const docName = 'runtime-refused-doc';
    const initial = '# Runtime refused doc\n\nPersisted paragraph.\n';
    const docPath = join(contentDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');
    writeFileSync(join(projectDir, '.okignore'), `content/${docName}.md\n`, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    try {
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      chmodSync(docPath, 0o000);
      server.durabilityState.deleteReconciledBase(docName);

      const refusalsBefore = getMetrics().persistenceDuplicationBaselineRefusals;
      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph refused at runtime.\n');
      });
      await executePendingStore(server, docName);
      await vi.waitFor(
        () =>
          expect(serverDoc.getText('source').toString()).toContain(
            'Unflushed paragraph refused at runtime.',
          ),
        { timeout: 5_000, interval: 25 },
      );

      await vi.waitFor(
        () =>
          expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
            refusalsBefore + 1,
          ),
        { timeout: 10_000, interval: 25 },
      );

      const markTimeRescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      expect(existsSync(markTimeRescuePath)).toBe(true);
      expect(readFileSync(markTimeRescuePath, 'utf-8')).toContain(
        'Unflushed paragraph refused at runtime.',
      );

      const doc2Name = 'runtime-refused-neighbor';
      const doc2Path = join(contentDir, `${doc2Name}.md`);
      writeFileSync(doc2Path, '# Runtime refused neighbor\n\nSecond doc.\n', 'utf-8');
      const conn2 = await server.hocuspocus.openDirectConnection(doc2Name);
      const serverDoc2 = server.hocuspocus.documents.get(doc2Name);
      expect(serverDoc2).toBeDefined();
      if (!serverDoc2) return;
      await vi.waitFor(
        () =>
          expect(server.durabilityState.getReconciledBase(doc2Name)).toBe(
            '# Runtime refused neighbor\n\nSecond doc.\n',
          ),
        { timeout: 5_000, interval: 25 },
      );
      await conn2.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nNeighbor pending store paragraph.\n');
      });
      serverDoc2.removeDirectConnection();

      serverDoc.removeDirectConnection();
      const startedAt = Date.now();
      await server.destroy();
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(1_450);
      expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
        refusalsBefore + 1,
      );
      const flushPhaseErrors = logCapture
        .getCalls('warn', 'shutdown flushed')
        .flatMap((entry) => (entry.payload.phaseErrors as Array<{ phase: string }>) ?? []);
      expect(flushPhaseErrors.some((p) => p.phase === 'flush-all-stores')).toBe(false);
      expect(
        logCapture.getCalls('info', 'refused-store doc rescued and unloaded').length,
      ).toBeGreaterThanOrEqual(1);

      const rescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      expect(existsSync(rescuePath)).toBe(true);
      expect(readFileSync(rescuePath, 'utf-8')).toContain(
        'Unflushed paragraph refused at runtime.',
      );
    } finally {
      chmodSync(docPath, 0o644);
      await server.destroy();
    }
  });

  test('a later refused store refreshes the runtime rescue buffer with the newest content', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const docName = 'runtime-refused-refresh';
    const initial = '# Runtime refused refresh\n\nPersisted paragraph.\n';
    const docPath = join(contentDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');
    writeFileSync(join(projectDir, '.okignore'), `content/${docName}.md\n`, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    try {
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      chmodSync(docPath, 0o000);
      server.durabilityState.deleteReconciledBase(docName);

      const refusalsBefore = getMetrics().persistenceDuplicationBaselineRefusals;
      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nFirst refused edit.\n');
      });
      await executePendingStore(server, docName);
      await vi.waitFor(
        () =>
          expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
            refusalsBefore + 1,
          ),
        { timeout: 20_000, interval: 25 },
      );

      const rescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      expect(readFileSync(rescuePath, 'utf-8')).toContain('First refused edit.');

      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nSecond refused edit.\n');
      });
      await executePendingStore(server, docName);
      await vi.waitFor(
        () =>
          expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
            refusalsBefore + 2,
          ),
        { timeout: 20_000, interval: 25 },
      );

      expect(readFileSync(rescuePath, 'utf-8')).toContain('Second refused edit.');
    } finally {
      chmodSync(docPath, 0o644);
      await server.destroy();
    }
  });

  test('destroy() leaves a refused-store doc loaded when its shutdown rescue cannot write and reports it lost', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const docName = 'refused-rescue-lost-doc';
    const initial = '# Refused rescue lost doc\n\nPersisted paragraph.\n';
    const docPath = join(contentDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');
    writeFileSync(join(projectDir, '.okignore'), `content/${docName}.md\n`, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    const chmodEntries: Array<{ path: string; mode: number }> = [];
    try {
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      const shadowGitDir = shadowHandle.gitDir;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const entryPath = join(dir, entry.name);
          chmodEntries.push({ path: entryPath, mode: statSync(entryPath).mode & 0o777 });
          if (entry.isDirectory()) walk(entryPath);
        }
      };
      chmodEntries.push({ path: shadowGitDir, mode: statSync(shadowGitDir).mode & 0o777 });
      walk(shadowGitDir);
      for (const entry of chmodEntries) chmodSync(entry.path, 0o500);

      chmodSync(docPath, 0o000);
      server.durabilityState.deleteReconciledBase(docName);

      const refusalsBefore = getMetrics().persistenceDuplicationBaselineRefusals;
      const rescueBufferWriteFailuresBefore = getMetrics().rescueBufferWriteFailures;
      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph the rescue cannot hold.\n');
      });
      await executePendingStore(server, docName);
      await vi.waitFor(
        () =>
          expect(getMetrics().persistenceDuplicationBaselineRefusals).toBeGreaterThanOrEqual(
            refusalsBefore + 1,
          ),
        { timeout: 20_000, interval: 25 },
      );

      const rescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      expect(existsSync(rescuePath)).toBe(false);

      serverDoc.removeDirectConnection();
      await server.destroy();

      expect(
        logCapture
          .getCalls('warn', 'refused-store doc rescue failed')
          .some((entry) => entry.payload.docName === docName),
      ).toBe(true);
      expect(getMetrics().rescueBufferWriteFailures).toBeGreaterThanOrEqual(
        rescueBufferWriteFailuresBefore + 2,
      );
      expect(
        logCapture
          .getCalls('info', 'refused-store doc rescued and unloaded')
          .some((entry) => entry.payload.docName === docName),
      ).toBe(false);
      expect(existsSync(rescuePath)).toBe(false);

      const flushPhaseErrors = logCapture
        .getCalls('warn', 'shutdown flushed')
        .flatMap(
          (entry) => (entry.payload.phaseErrors as Array<{ phase: string; error: string }>) ?? [],
        );
      const flushErr = flushPhaseErrors.find((e) => e.phase === 'flush-all-stores');
      expect(flushErr?.error).toContain(`lost [${docName}]`);
    } finally {
      for (const entry of chmodEntries) {
        if (!existsSync(entry.path)) continue;
        chmodSync(entry.path, entry.mode);
      }
      chmodSync(docPath, 0o644);
      await server.destroy();
    }
  });

  test('destroy() leaves a refused-store doc to the flush timeout when its unload hangs past the deadline and reports the late completion', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const docName = 'refused-unload-hangs-doc';
    const initial = '# Refused unload hangs doc\n\nPersisted paragraph.\n';
    const docPath = join(contentDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');
    writeFileSync(join(projectDir, '.okignore'), `content/${docName}.md\n`, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    try {
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      chmodSync(docPath, 0o000);
      server.durabilityState.deleteReconciledBase(docName);

      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph behind a hanging unload.\n');
      });
      await executePendingStore(server, docName);

      server.hocuspocus.configuration.extensions.push({
        async beforeUnloadDocument(payload: { documentName: string }) {
          if (payload.documentName !== docName) return;
          await new Promise((resolve) => setTimeout(resolve, 2_500));
        },
      });

      const rescuePath = join(shadowHandle.gitDir, 'rescue', `${docName}.md`);
      const rescueContentBeforeDestroy = readFileSync(rescuePath, 'utf-8');
      expect(rescueContentBeforeDestroy).toContain('Unflushed paragraph behind a hanging unload.');

      serverDoc.removeDirectConnection();
      const startedAt = Date.now();
      await server.destroy();
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(10_000);
      expect(
        logCapture
          .getCalls('warn', 'did not finish before the flush deadline')
          .some((entry) => entry.payload.docName === docName),
      ).toBe(true);
      expect(existsSync(rescuePath)).toBe(true);
      expect(readFileSync(rescuePath, 'utf-8')).toContain(
        'Unflushed paragraph behind a hanging unload.',
      );

      const flushPhaseErrors = logCapture
        .getCalls('warn', 'shutdown flushed')
        .flatMap(
          (entry) => (entry.payload.phaseErrors as Array<{ phase: string; error: string }>) ?? [],
        );
      const flushErr = flushPhaseErrors.find((e) => e.phase === 'flush-all-stores');
      expect(flushErr?.error).toContain(`rescued [${docName}]`);

      await vi.waitFor(
        () =>
          expect(
            logCapture
              .getCalls('info', 'completed after the flush deadline')
              .some((entry) => entry.payload.docName === docName),
          ).toBe(true),
        { timeout: 10_000, interval: 25 },
      );
    } finally {
      chmodSync(docPath, 0o644);
      await server.destroy();
    }
  }, 30_000);

  test('destroy() does not hand a second refused-store doc a budget the first one already spent', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);

    const firstDoc = 'refused-budget-hog-doc';
    const secondDoc = 'refused-budget-starved-doc';
    const docNames = [firstDoc, secondDoc];
    const initialOf = (docName: string) => `# ${docName}\n\nPersisted paragraph.\n`;
    const pathOf = (docName: string) => join(contentDir, `${docName}.md`);
    for (const docName of docNames) {
      writeFileSync(pathOf(docName), initialOf(docName), 'utf-8');
    }
    writeFileSync(
      join(projectDir, '.okignore'),
      docNames.map((docName) => `content/${docName}.md\n`).join(''),
      'utf-8',
    );

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      shadowRepo: shadowHandle,
    });
    await server.ready;

    try {
      for (const docName of docNames) {
        const conn = await server.hocuspocus.openDirectConnection(docName);
        const serverDoc = server.hocuspocus.documents.get(docName);
        expect(serverDoc).toBeDefined();
        if (!serverDoc) return;
        await vi.waitFor(
          () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initialOf(docName)),
          { timeout: 5_000, interval: 25 },
        );

        chmodSync(pathOf(docName), 0o000);
        server.durabilityState.deleteReconciledBase(docName);

        await conn.transact((doc) => {
          const source = doc.getText('source');
          source.insert(source.length, `\nUnflushed paragraph for ${docName}.\n`);
        });
        await executePendingStore(server, docName);
        await vi.waitFor(() => expect(server.durabilityState.isStoreRefused(docName)).toBe(true), {
          timeout: 20_000,
          interval: 25,
        });
        serverDoc.removeDirectConnection();
      }

      expect(server.durabilityState.getRefusedStoreDocNames()).toEqual(docNames);

      server.hocuspocus.configuration.extensions.push({
        async beforeUnloadDocument(payload: { documentName: string }) {
          if (payload.documentName === firstDoc) {
            await new Promise((resolve) => setTimeout(resolve, 2_500));
          } else if (payload.documentName === secondDoc) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        },
      });

      await server.destroy();

      const starvedWarns = logCapture.getCalls('warn', 'did not finish before the flush deadline');
      expect(
        starvedWarns.map((entry) => ({
          docName: entry.payload.docName,
          unloadDeadline: entry.payload.unloadDeadline,
        })),
      ).not.toContainEqual(expect.objectContaining({ unloadDeadline: 0 }));
      expect(starvedWarns.some((entry) => entry.payload.docName === secondDoc)).toBe(false);
    } finally {
      for (const docName of docNames) chmodSync(pathOf(docName), 0o644);
      await server.destroy();
    }
  }, 40_000);

  test('a shadowless server logs and counts the rescue losses the flush timeout and skipped mints declare', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    const shadowGitDir = join(projectDir, '.git');
    chmodSync(shadowGitDir, 0o500);
    writeFileSync(join(projectDir, '.okignore'), 'content/shadowless-flush-doc.md\n', 'utf-8');

    const mintDocName = 'shadowless-mint-doc';
    const mintInitial = '# Shadowless mint doc\n\nPersisted paragraph.\n';
    const mintDocPath = join(contentDir, `${mintDocName}.md`);
    writeFileSync(mintDocPath, mintInitial, 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      destroyTimeoutMs: 1500,
      gitEnabled: false,
    });
    await server.ready;

    try {
      const conn = await server.hocuspocus.openDirectConnection(mintDocName);
      const serverDoc = server.hocuspocus.documents.get(mintDocName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(mintDocName)).toBe(mintInitial),
        { timeout: 5_000, interval: 25 },
      );

      const failuresBefore = getMetrics().rescueBufferWriteFailures;
      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph the shadowless server cannot mint.\n');
      });
      chmodSync(mintDocPath, 0o000);
      unlinkSync(mintDocPath);

      await vi.waitFor(
        () =>
          expect(
            logCapture
              .getCalls('warn', 'rescue checkpoint not minted')
              .some(
                (entry) =>
                  entry.payload.docName === mintDocName &&
                  entry.msg.includes('the delete that follows destroys the document content'),
              ),
          ).toBe(true),
        { timeout: 15_000, interval: 25 },
      );

      const flushDocName = 'shadowless-flush-doc';
      const flushDocPath = join(contentDir, `${flushDocName}.md`);
      writeFileSync(flushDocPath, '# Shadowless flush doc\n\nSecond doc.\n', 'utf-8');
      const _conn2 = await server.hocuspocus.openDirectConnection(flushDocName);
      const serverDoc2 = server.hocuspocus.documents.get(flushDocName);
      expect(serverDoc2).toBeDefined();
      if (!serverDoc2) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(flushDocName)).toBeDefined(),
        { timeout: 5_000, interval: 25 },
      );

      const originalShouldUnload = server.hocuspocus.shouldUnloadDocument.bind(server.hocuspocus);
      server.hocuspocus.shouldUnloadDocument = (document) => {
        if (document.name === '__system__') return false;
        return originalShouldUnload(document);
      };
      server.hocuspocus.configuration.extensions.push({
        async beforeUnloadDocument(payload: { documentName: string }) {
          if (payload.documentName !== flushDocName) return;
          await new Promise(() => {});
        },
      });

      serverDoc.removeDirectConnection();
      serverDoc2.removeDirectConnection();
      await server.destroy();

      expect(
        logCapture.getCalls('warn', 'shadow repo unavailable at flush timeout').length,
      ).toBeGreaterThanOrEqual(1);
      const flushPhaseErrors = logCapture
        .getCalls('warn', 'shutdown flushed')
        .flatMap(
          (entry) => (entry.payload.phaseErrors as Array<{ phase: string; error: string }>) ?? [],
        );
      const flushErr = flushPhaseErrors.find((e) => e.phase === 'flush-all-stores');
      expect(flushErr?.error).toContain(`lost [${flushDocName}]`);
      const lostList = flushErr?.error.match(/lost \[[^\]]*\]/)?.[0];
      expect(lostList).toBe(`lost [${flushDocName}]`);
      expect(getMetrics().rescueBufferWriteFailures).toBeGreaterThanOrEqual(failuresBefore + 2);
    } finally {
      chmodSync(shadowGitDir, 0o755);
      if (existsSync(mintDocPath)) chmodSync(mintDocPath, 0o644);
      await server.destroy();
    }
  }, 30_000);

  test('destroy() is idempotent under concurrent calls', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-idempotent');
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'idempotent content\n');
    });
    const doc = server.hocuspocus.documents.get('test-idempotent');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await Promise.all([server.destroy(), server.destroy()]);

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);

    await server.destroy();
  });

  test('destroy() during async init — before ready resolves', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.destroy();

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
  });

  test('destroy() with zero documents loaded (short-circuit path)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBe(5);
  });

  test('destroy does not await the derived-index cache drain', async () => {
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      destroyTimeoutMs: 500,
    });
    await server.ready;
    const coordinator = beginStartup.mock.instances[0] as DerivedDocumentIndex;
    beginStartup.mockRestore();
    const close = vi
      .spyOn(DerivedDocumentIndex.prototype, 'close')
      .mockImplementation(() => new Promise<void>(() => {}));
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        server.destroy().then(() => 'destroyed' as const),
        new Promise<'timed-out'>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout('timed-out'), 2_000);
        }),
      ]);

      expect(result).toBe('destroyed');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      close.mockRestore();
      await coordinator.close();
    }
  });

  test('destroy() flushes multiple documents before resolving (multi-doc drain)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    const conn1 = await server.hocuspocus.openDirectConnection('doc-a');
    const conn2 = await server.hocuspocus.openDirectConnection('doc-b');
    const conn3 = await server.hocuspocus.openDirectConnection('doc-c');

    await conn1.transact((doc) => {
      doc.getText('source').insert(0, 'content A\n');
    });
    await conn2.transact((doc) => {
      doc.getText('source').insert(0, 'content B\n');
    });
    await conn3.transact((doc) => {
      doc.getText('source').insert(0, 'content C\n');
    });

    for (const name of ['doc-a', 'doc-b', 'doc-c']) {
      const doc = server.hocuspocus.documents.get(name);
      expect(doc).toBeDefined();
      doc?.removeDirectConnection();
    }

    await server.destroy();

    expect(await readFile(join(tmpDir, 'doc-a.md'), 'utf-8')).toContain('content A');
    expect(await readFile(join(tmpDir, 'doc-b.md'), 'utf-8')).toContain('content B');
    expect(await readFile(join(tmpDir, 'doc-c.md'), 'utf-8')).toContain('content C');

    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBe(8);
  });
});

describe('createServer() degraded signal', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-degraded-test-'));
  });

  afterEach(() => {
    watcherStartupFailures.file = false;
    watcherStartupFailures.head = false;
    resetBootTimingsForTest();
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('clean init — degraded is empty array', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(Array.isArray(srv.degraded)).toBe(true);
    expect(srv.degraded).toEqual([]);

    await srv.destroy();
  });

  test('backlink startup failure labels the server as backlink-index degraded', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const load = vi
      .spyOn(BacklinkIndex.prototype, 'loadFromDisk')
      .mockRejectedValueOnce(new Error('injected backlink startup failure'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    try {
      await srv.ready;
      expect(load).toHaveBeenCalled();
      expect(srv.degraded).toContain('backlink-index');
      expect(srv.degraded.filter((name) => name === 'backlink-index')).toHaveLength(1);
    } finally {
      load.mockRestore();
      await srv.destroy();
    }
  });

  test('tag reconciliation failure labels the server as tag-index degraded', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const beginStartup = vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup');
    const reconcile = vi
      .spyOn(TagIndex.prototype, 'reconcileWithDisk')
      .mockRejectedValueOnce(new Error('injected tag reconciliation failure'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    try {
      await srv.ready;
      const coordinator = beginStartup.mock.instances[0] as DerivedDocumentIndex;
      expect(reconcile).toHaveBeenCalled();
      expect(srv.degraded).toContain('tag-index');
      expect(srv.degraded.filter((name) => name === 'tag-index')).toHaveLength(1);
      await expect(coordinator.getAllTags()).resolves.toBeInstanceOf(Array);
    } finally {
      await srv.destroy();
      beginStartup.mockRestore();
      reconcile.mockRestore();
    }
  });

  test('shadow-repo init failure — degraded includes "shadow-repo"', async () => {
    mkdirSync(resolve(testProjectDir, '.git'));
    writeFileSync(resolve(testProjectDir, '.git', 'ok'), 'I am a file, not a directory');

    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(srv.degraded).toContain('shadow-repo');
    expect(srv.degraded.filter((s) => s === 'shadow-repo')).toHaveLength(1);

    await srv.destroy();
  });

  test('shadow exclude write refusal — degraded includes "shadow-excludes"', async () => {
    mkdirSync(resolve(testProjectDir, '.git', 'ok', 'info'), { recursive: true });
    symlinkSync(
      resolve(testProjectDir, 'planted-exclude-target'),
      resolve(testProjectDir, '.git', 'ok', 'info', 'exclude'),
    );

    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    try {
      await srv.ready;
      expect(srv.degraded).toContain('shadow-excludes');
      expect(srv.degraded.filter((s) => s === 'shadow-excludes')).toHaveLength(1);
    } finally {
      await srv.destroy();
    }
  });

  test.each([
    { failure: 'file' as const, label: 'file-watcher' },
    { failure: 'head' as const, label: 'head-watcher' },
  ])('$label startup failure is reported at runtime', async ({ failure, label }) => {
    watcherStartupFailures[failure] = true;
    if (failure === 'file') startBootTimings('2026-07-23T00:00:00.000Z');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    try {
      await srv.ready;
      expect(srv.degraded).toEqual([label]);
      if (failure === 'file') {
        expect(getBootTimings()?.indexesMs).toEqual(expect.any(Number));
      }
    } finally {
      await srv.destroy();
    }
  });

  test('an .mdx conflict restored before any scan resolves to its .mdx file', async () => {
    watcherStartupFailures.file = true;
    _resetDocExtensionsForTests();
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const diskContent = 'bytes the editor tried to overwrite';
    mkdirSync(join(testProjectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(
      join(testProjectDir, '.ok', LOCAL_DIR, 'stale-external-writes.json'),
      JSON.stringify({
        version: 1,
        branches: {
          main: [
            {
              docName: 'notes/guide',
              acknowledgedContent: 'acknowledged',
              displacedVersions: [],
              staleExternalWrite: {
                docName: 'notes/guide',
                file: `${resolve(contentDir).slice(resolve(testProjectDir).length + 1)}/notes/guide.mdx`,
                diskHash: contentHash(diskContent),
                diskContent,
                detectedAt: '2026-09-08T10:00:00.000Z',
              },
            },
          ],
        },
      }),
    );

    const srv = createServer({ contentDir, projectDir: testProjectDir, quiet: true });
    try {
      await srv.ready;
      expect(srv.degraded).toEqual(['file-watcher']);
      expect(srv.durabilityState.getStaleExternalWrite('notes/guide')?.file).toMatch(
        /notes\/guide\.mdx$/,
      );
    } finally {
      await srv.destroy();
      _resetDocExtensionsForTests();
    }
  });

  test('degraded is readonly — push and reassignment are compile-time errors', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv: ServerInstance = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    // @ts-expect-error — readonly array: push is not allowed
    srv.degraded.push('test');

    // @ts-expect-error — readonly field: reassignment is not allowed
    srv.degraded = [];

    await srv.ready;
    await srv.destroy();
  });
});

describe('createServer() — config-doc admission (US-005)', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-config-admission-test-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('boot admits all three config docs alongside __system__', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    expect(srv.hocuspocus.documents.has('__system__')).toBe(true);
    expect(srv.hocuspocus.documents.has('__config__/project')).toBe(true);
    expect(srv.hocuspocus.documents.has('__local__/project')).toBe(true);
    expect(srv.hocuspocus.documents.has('__user__/config.yml')).toBe(true);
    expect(srv.degraded.filter((s) => s.startsWith('config-doc:'))).toEqual([]);

    await srv.destroy();
  });

  test('connecting a transient client to a config doc succeeds via existing collab WS (D49)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    const conn = await srv.hocuspocus.openDirectConnection('__config__/project');
    try {
      const document = conn.document;
      expect(document).toBeDefined();
      const text = document.getText('source');
      expect(typeof text.toString()).toBe('string');
    } finally {
      await conn.disconnect();
    }

    await srv.destroy();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('createServer() — config file watcher (US-007)', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-cfg-watcher-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-cfg-watcher-home-'));
  });

  afterEach(() => {
    loggerFactory.reset();
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  test('external write to project config.yml propagates to Y.Text within 4s', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    expect(ytext.toString()).toBe('');

    const configPath = join(testProjectDir, '.ok', 'config.yml');
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    const newContent = 'mcp:\n  autoStart: false\n';
    writeFileSync(configPath, newContent, 'utf-8');

    const fired = await waitFor(() => ytext.toString() === newContent);
    expect(fired).toBe(true);

    await srv.destroy();
  });

  test('external broken-YAML write keeps Y.Text at LKG and does not crash the server', async () => {
    const logs = captureAllLoggers();
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const configPath = join(testProjectDir, '.ok', 'config.yml');
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    const validContent = 'mcp:\n  autoStart: false\n';
    writeFileSync(configPath, validContent, 'utf-8');

    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    expect(ytext.toString()).toBe(validContent);

    writeFileSync(configPath, 'content: [unclosed\n', 'utf-8');
    const warningLogged = await waitFor(
      () => logs.getCalls('warn', 'project config invalid').length > 0,
    );

    expect(warningLogged).toBe(true);
    expect(ytext.toString()).toBe(validContent);
    const warning = logs.getCalls('warn', 'project config invalid').at(-1);
    expect(warning?.payload.err).toBeInstanceOf(Error);
    expect((warning?.payload.err as Error | undefined)?.cause).toMatchObject({
      code: 'YAML_PARSE',
    });

    await srv.destroy();
  });

  test('persistence-hook write does not produce a feedback-loop mutation (LKG-equality short-circuit)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) {
      await srv.destroy();
      return;
    }
    const ytext = configDoc.getText('source');

    const newContent = 'mcp:\n  autoStart: false\n';
    configDoc.transact(() => {
      ytext.insert(0, newContent);
    });

    const configPath = join(testProjectDir, '.ok', 'config.yml');
    const fileLanded = await waitFor(
      () => existsSync(configPath) && readFileSync(configPath, 'utf-8') === newContent,
    );
    expect(fileLanded).toBe(true);

    const observedOrigins: unknown[] = [];
    configDoc.on('afterTransaction', (tx: { origin: unknown }) => {
      observedOrigins.push(tx.origin);
    });
    await new Promise((r) => setTimeout(r, 1_500));

    expect(ytext.toString()).toBe(newContent);

    const filewatcherOrigins = observedOrigins.filter(
      (o) =>
        o !== null &&
        typeof o === 'object' &&
        'context' in o &&
        typeof (o as { context: unknown }).context === 'object' &&
        (o as { context: { origin?: unknown } }).context.origin === 'config-file-watcher',
    );
    expect(filewatcherOrigins).toEqual([]);

    await srv.destroy();
  });
});

describe('createServer() — project-local file watcher → engine.setMode', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-pl-engine-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-pl-engine-home-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  test('external write of autoSync.enabled: true to project-local flips engine state', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    const localDir = join(testProjectDir, '.ok', LOCAL_DIR);
    mkdirSync(localDir, { recursive: true });
    const configPath = join(localDir, 'config.yml');
    writeFileSync(configPath, 'autoSync:\n  enabled: true\n', 'utf-8');

    const flipped = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === true);
    expect(flipped).toBe(true);

    await srv.destroy();
  });

  test('toggling autoSync.enabled: false on disk disables the engine within 4s', async () => {
    mkdirSync(join(testProjectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(
      join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'),
      'autoSync:\n  enabled: true\n',
      'utf-8',
    );

    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);

    writeFileSync(
      join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'),
      'autoSync:\n  enabled: false\n',
      'utf-8',
    );

    const disabled = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === false);
    expect(disabled).toBe(true);

    await srv.destroy();
  });

  test('external write of committed autoSync.default: true flips engine state (unanswered machine)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;

    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(testProjectDir, '.ok', 'config.yml'),
      'autoSync:\n  default: true\n',
      'utf-8',
    );

    const flipped = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === true);
    expect(flipped).toBe(true);

    await srv.destroy();
  });
});

function nestRemovedKey(path: readonly string[], leaf: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return {};
  return { [head]: rest.length === 0 ? leaf : nestRemovedKey(rest, leaf) };
}

describe('createServer() — a removed key in project-local config does not disable sync', () => {
  let testProjectDir: string;
  let testHomedir: string;
  let servers: ServerInstance[];
  let logCapture: ReturnType<typeof captureAllLoggers>;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-removed-key-sync-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-removed-key-home-'));
    servers = [];
    logCapture = captureAllLoggers();
  });

  afterEach(async () => {
    for (const srv of servers) {
      await srv.destroy();
    }
    loggerFactory.reset();
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  function writeProjectLocal(yaml: string): void {
    const localDir = join(testProjectDir, '.ok', LOCAL_DIR);
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'config.yml'), yaml, 'utf-8');
  }

  async function boot(): Promise<ServerInstance> {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    servers.push(srv);
    await srv.ready;
    return srv;
  }

  test('a stale showAllFiles key beside autoSync.mode: full still resolves full and reports the removed key', async () => {
    writeProjectLocal(
      stringifyYaml({
        autoSync: { mode: 'full' },
        appearance: { sidebar: { showAllFiles: false } },
      }),
    );
    const srv = await boot();

    expect(srv.syncEngine?.getStatus().syncMode).toBe('full');

    const reportedRemovedKey = logCapture
      .getCalls('warn')
      .some(
        (entry) =>
          entry.payload.path === 'appearance.sidebar.showAllFiles' &&
          typeof entry.msg === 'string' &&
          entry.msg.includes('appearance.sidebar.showAllFiles'),
      );
    expect(reportedRemovedKey).toBe(true);
  });

  test.each(REMOVED_KEYS.map((entry) => ({ entry, dotted: entry.path.join('.') })))(
    'registry key $dotted beside autoSync.mode: full still resolves full',
    async ({ entry }) => {
      writeProjectLocal(
        stringifyYaml({ autoSync: { mode: 'full' }, ...nestRemovedKey(entry.path, false) }),
      );
      const srv = await boot();
      expect(srv.syncEngine?.getStatus().syncMode).toBe('full');
    },
  );

  test('a removed key beside linkPreviews.enabled: true resolves link previews enabled', async () => {
    const srv = await boot();
    writeProjectLocal(
      stringifyYaml({
        linkPreviews: { enabled: true },
        appearance: { sidebar: { showAllFiles: false } },
      }),
    );
    expect(srv.getLinkPreviewsEnabled()).toBe(true);
  });

  test('unparseable project-local YAML still fails link previews closed', async () => {
    const srv = await boot();
    writeProjectLocal('linkPreviews:\n  enabled: true\ntrailing: [1, 2\n');
    expect(srv.getLinkPreviewsEnabled()).toBe(false);
  });

  test('a schema-invalid project-local config still fails link previews closed', async () => {
    const srv = await boot();
    writeProjectLocal(stringifyYaml({ linkPreviews: { enabled: 'not-a-boolean' } }));
    expect(srv.getLinkPreviewsEnabled()).toBe(false);
  });
});

describe('createServer() — okignore + gitignore multi-path watcher (US-005)', () => {
  let testProjectDir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-okignore-watcher-test-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
  });

  test('external write to .okignore propagates to __config__/okignore Y.Text + ContentFilter rebuilds', async () => {
    mkdirSync(join(testProjectDir, 'drafts'), { recursive: true });
    writeFileSync(join(testProjectDir, 'keep.md'), '# Keep\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'drafts', 'foo.md'), '# Foo\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('drafts/foo.md')).toBe(false);
    expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    expect(okignoreDoc).toBeDefined();
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');
    expect(ytext.toString()).toBe('');

    const okignorePath = join(testProjectDir, '.okignore');
    const newContent = 'drafts/\n';
    writeFileSync(okignorePath, newContent, 'utf-8');

    const ytextSynced = await waitFor(() => ytext.toString() === newContent);
    expect(ytextSynced).toBe(true);

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('drafts/foo.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

    await srv.destroy();
  });

  test('external write to .gitignore triggers ContentFilter rebuild WITHOUT mutating __config__/okignore Y.Text', async () => {
    mkdirSync(join(testProjectDir, 'logs'), { recursive: true });
    writeFileSync(join(testProjectDir, 'index.md'), '# Index\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'logs', 'debug.md'), '# Debug\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('logs/debug.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');
    expect(ytext.toString()).toBe('');

    const gitignorePath = join(testProjectDir, '.gitignore');
    writeFileSync(gitignorePath, 'logs/\n', 'utf-8');

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('logs/debug.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('index.md')).toBe(false);
    expect(ytext.toString()).toBe('');

    await srv.destroy();
  });

  test('persistence-hook write of __config__/okignore Y.Text ends in atomic .okignore on disk + ContentFilter visibility change', async () => {
    writeFileSync(join(testProjectDir, 'visible.md'), '# Visible\n', 'utf-8');
    mkdirSync(join(testProjectDir, 'tmp'), { recursive: true });
    writeFileSync(join(testProjectDir, 'tmp', 'cache.md'), '# Cache\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    expect(srv.contentFilter.isExcluded('tmp/cache.md')).toBe(false);

    const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
    if (!okignoreDoc) {
      await srv.destroy();
      return;
    }
    const ytext = okignoreDoc.getText('source');

    const newContent = 'tmp/\n';
    okignoreDoc.transact(() => {
      ytext.insert(0, newContent);
    });

    const okignorePath = join(testProjectDir, '.okignore');
    const fileLanded = await waitFor(
      () => existsSync(okignorePath) && readFileSync(okignorePath, 'utf-8') === newContent,
    );
    expect(fileLanded).toBe(true);

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('tmp/cache.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('visible.md')).toBe(false);

    await srv.destroy();
  });

  test('Y.Text mirror throw does NOT block ContentFilter rebuild', async () => {
    mkdirSync(join(testProjectDir, 'drafts'), { recursive: true });
    writeFileSync(join(testProjectDir, 'keep.md'), '# Keep\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'drafts', 'foo.md'), '# Foo\n', 'utf-8');

    const logCapture = captureAllLoggers();
    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    try {
      await srv.ready;
      expect(srv.contentFilter.isExcluded('drafts/foo.md')).toBe(false);

      const okignoreDoc = srv.hocuspocus.documents.get('__config__/okignore');
      expect(okignoreDoc).toBeDefined();
      if (!okignoreDoc) return;

      const origTransact = okignoreDoc.transact.bind(okignoreDoc);
      Object.defineProperty(okignoreDoc, 'transact', {
        value: () => {
          throw new Error('test-injected: simulated Y.Doc transact failure');
        },
        writable: true,
        configurable: true,
      });

      try {
        const okignorePath = join(testProjectDir, '.okignore');
        writeFileSync(okignorePath, 'drafts/\n', 'utf-8');

        const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('drafts/foo.md'));
        expect(filterUpdated).toBe(true);
        expect(srv.contentFilter.isExcluded('keep.md')).toBe(false);

        const errorEntries = logCapture.getCalls('error', 'applyExternalConfigChange failed');
        expect(errorEntries.length).toBeGreaterThanOrEqual(1);
      } finally {
        Object.defineProperty(okignoreDoc, 'transact', {
          value: origTransact,
          writable: true,
          configurable: true,
        });
      }
    } finally {
      loggerFactory.reset();
      await srv.destroy();
    }
  });
});

describe('createServer() managed rename recovery', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-managed-rename-recovery-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('replays a pending managed rename journal before watcher startup', async () => {
    writeFileSync(join(tmpDir, 'beta.md'), '# Alpha\n', 'utf-8');
    writeFileSync(join(tmpDir, 'referrer.md'), 'See [[beta]].\n', 'utf-8');
    writeManagedRenameJournal(
      tmpDir,
      createManagedRenameRecoveryJournal({
        fromPath: 'alpha',
        toPath: 'beta',
        affectedDocs: [{ from: 'alpha', to: 'beta' }],
        snapshots: [
          { docName: 'alpha', content: '# Alpha\n' },
          { docName: 'referrer', content: 'See [[alpha]].\n' },
        ],
      }),
    );

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(readFileSync(join(tmpDir, 'alpha.md'), 'utf-8')).toBe('# Alpha\n');
    expect(readFileSync(join(tmpDir, 'referrer.md'), 'utf-8')).toBe('See [[alpha]].\n');
    expect(existsSync(join(tmpDir, 'beta.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(tmpDir))).toBe(false);

    await server.destroy();
  });

  test('marks the server degraded when the managed rename journal is corrupt', async () => {
    mkdirSync(join(tmpDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(managedRenameJournalPath(tmpDir), '{not valid json', 'utf-8');

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(server.degraded).toContain('managed-rename-recovery');

    await server.destroy();
  });
});

describe('createServer() server-lock integration (V0-1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-server-lock-int-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('acquires server.lock at createServer(), drains on destroy() (unlink deferred to exit)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    expect(existsSync(lockPath)).toBe(true);
    const md = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.worktreeRoot).toBe(tmpDir);
    expect(md.draining).toBeUndefined();

    await server.destroy();

    expect(existsSync(lockPath)).toBe(true);
    const drained = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(drained.pid).toBe(process.pid);
    expect(drained.draining).toBe(true);
  });

  test('exposes lockDir on ServerInstance', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    expect(server.lockDir).toBe(join(tmpDir, '.ok', LOCAL_DIR));

    await server.destroy();
  });

  test('second createServer() on same contentDir rejects with collision error', async () => {
    const first = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await first.ready;

    const { hostname } = await import('node:os');
    const foreignPid = process.ppid > 1 ? process.ppid : process.pid + 1;
    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: foreignPid,
        hostname: hostname(),
        port: 9999,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
      'utf-8',
    );

    expect(() => createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true })).toThrow(
      /already running at port 9999/,
    );

    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        port: 0,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
      'utf-8',
    );

    await first.destroy();
  });

  test('updateServerLockPort through createServer().lockDir updates on-disk port', async () => {
    const { updateServerLockPort, readServerLock } = await import('./server-lock.ts');
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    const before = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(before.port).toBe(0);

    updateServerLockPort(server.lockDir, 5173);

    const after = readServerLock(server.lockDir);
    expect(after).not.toBeNull();
    expect(after?.port).toBe(5173);
    expect(after?.pid).toBe(process.pid);

    await server.destroy();
  });

  test('acquire stamps the port=0 sentinel even when an explicit port is configured', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      port: 8080,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    const acquired = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(acquired.port).toBe(0);

    await server.destroy();
  });

  test('destroy() drains server.lock even when a shutdown phase throws (CC8)', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    await server.ready;

    const lockPath = join(tmpDir, '.ok', LOCAL_DIR, 'server.lock');
    expect(existsSync(lockPath)).toBe(true);

    const origCloseAll = server.sessionManager.closeAll.bind(server.sessionManager);
    server.sessionManager.closeAll = async () => {
      await origCloseAll();
      throw new Error('Injected Phase 2 failure');
    };

    await server.destroy();
    const drained = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(drained.draining).toBe(true);
  });
});

describe('createServer() — serverInstanceId', () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(async () => {
    tmpDirA = await mkdtemp(join(tmpdir(), 'ok-iid-a-'));
    tmpDirB = await mkdtemp(join(tmpdir(), 'ok-iid-b-'));
  });

  afterEach(async () => {
    await rm(tmpDirA, { recursive: true, force: true });
    await rm(tmpDirB, { recursive: true, force: true });
  });

  test('each createServer() call produces a distinct serverInstanceId (UUID)', async () => {
    const serverA = createServer({ contentDir: tmpDirA, projectDir: tmpDirA, quiet: true });
    const serverB = createServer({ contentDir: tmpDirB, projectDir: tmpDirB, quiet: true });
    try {
      await serverA.ready;
      await serverB.ready;

      expect(typeof serverA.serverInstanceId).toBe('string');
      expect(serverA.serverInstanceId.length).toBeGreaterThan(0);
      expect(typeof serverB.serverInstanceId).toBe('string');
      expect(serverB.serverInstanceId.length).toBeGreaterThan(0);

      expect(serverA.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(serverB.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      expect(serverA.serverInstanceId).not.toBe(serverB.serverInstanceId);
    } finally {
      await serverA.destroy();
      await serverB.destroy();
    }
  });
});

describe("createServer() — onAuthenticate rejects 'server-instance-mismatch'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-mismatch-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('token claiming a mismatched expectedServerInstanceId is rejected', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const staleToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: 'stale-server-id-from-prior-process',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({
          token: staleToken,
          context,
          documentName: 'test-doc',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).not.toBeNull();
      expect((thrown as { reason?: string }).reason).toBe('server-instance-mismatch');
      expect(context.principalId).toBeUndefined();
      expect(context.kind).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('token claiming the matching serverInstanceId is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const goodToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: server.serverInstanceId,
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: goodToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('legacy token without expectedServerInstanceId is accepted (backward compat)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const legacyToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: legacyToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('missing token is accepted (anonymous legacy path)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: undefined,
        context,
        documentName: 'test-doc',
      });

      expect(context.principalId).toBeUndefined();
      expect(context.kind).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('empty-string expectedServerInstanceId claim is treated as absent (not rejected)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const emptyClaimToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedServerInstanceId: '',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: emptyClaimToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });
});

describe("createServer() — onAuthenticate rejects 'branch-mismatch'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-branch-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('token claiming a mismatched expectedBranch is rejected', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);
      const staleToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'feature',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({
          token: staleToken,
          context,
          documentName: 'test-doc',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).not.toBeNull();
      expect((thrown as { reason?: string }).reason).toBe('branch-mismatch');
      expect(context.principalId).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });

  test('token claiming the matching branch is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const goodToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'main',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: goodToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
      expect(context.tabSessionId).toBe('s-1');
    } finally {
      await server.destroy();
    }
  });

  test('empty-string expectedBranch is treated as absent (legacy path)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const emptyClaimToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: '',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: emptyClaimToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });

  test('legacy token without expectedBranch is accepted', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      const legacyToken = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
      });
      const context: Record<string, unknown> = {};

      await authExt.onAuthenticate({
        token: legacyToken,
        context,
        documentName: 'test-doc',
      });

      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — onAuthenticate branch gate parks on readiness', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-branch-boot-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('a claim matching the real HEAD branch survives the boot window', async () => {
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    writeFileSync(join(tmpDir, 'seed.md'), '# Seed\n');
    await git.add('.');
    await git.commit('seed');

    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      const authExt = getAuthExtension(server);
      const token = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'master',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({ token, context, documentName: 'boot-window-doc' });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeNull();
      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });

  test('a genuinely stale claim is still rejected after the branch resolves', async () => {
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    writeFileSync(join(tmpDir, 'seed.md'), '# Seed\n');
    await git.add('.');
    await git.commit('seed');

    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      const authExt = getAuthExtension(server);
      const token = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'some-other-branch',
      });
      const context: Record<string, unknown> = {};

      let thrown: unknown = null;
      try {
        await authExt.onAuthenticate({ token, context, documentName: 'boot-window-doc' });
      } catch (err) {
        thrown = err;
      }

      expect((thrown as { reason?: string } | null)?.reason).toBe('branch-mismatch');
      expect((thrown as { message?: string } | null)?.message).toContain('master');
    } finally {
      await server.destroy();
    }
  });

  test('admission settles before the rest of boot does', async () => {
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    const noteCount = 120;
    for (let i = 0; i < noteCount; i++) {
      writeFileSync(
        join(tmpDir, `note-${i}.md`),
        `# Note ${i}\n\nSee [[note-${(i + 1) % noteCount}]].\n`,
      );
    }
    await git.add('.');
    await git.commit('seed');

    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      const order: string[] = [];
      const readySettled = server.ready.then(
        () => order.push('ready'),
        () => order.push('ready'),
      );

      const authExt = getAuthExtension(server);
      const token = JSON.stringify({
        principalId: 'p-1',
        tabSessionId: 's-1',
        expectedBranch: 'master',
      });
      await authExt.onAuthenticate({ token, context: {}, documentName: 'boot-window-doc' });
      order.push('auth');

      await readySettled;
      expect(order[0]).toBe('auth');
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — onAuthenticate rejections reach the structured log', () => {
  let tmpDir: string;
  let logCapture: ReturnType<typeof captureAllLoggers>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-log-'));
    logCapture = captureAllLoggers();
  });
  afterEach(async () => {
    loggerFactory.reset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getAuthExtension(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'principal-auth',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected principalAuthExtension on hocuspocus.configuration');
    return ext;
  }

  test('branch-mismatch rejection emits a warn carrying claimed and current branch', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      await expect(
        authExt.onAuthenticate({
          token: JSON.stringify({ principalId: 'p-1', expectedBranch: 'feature' }),
          context: {},
          documentName: 'notes/alpha',
        }),
      ).rejects.toMatchObject({ reason: 'branch-mismatch' });

      const warns = logCapture.getCalls('warn', '[auth-rejection]');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toBe('[auth-rejection] branch-mismatch');
      expect(warns[0]?.payload).toMatchObject({
        reason: 'branch-mismatch',
        docName: 'notes/alpha',
        claimedBranch: 'feature',
        currentBranch: 'main',
      });
    } finally {
      await server.destroy();
    }
  });

  test('server-instance-mismatch rejection emits a warn carrying both instance ids', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      await expect(
        authExt.onAuthenticate({
          token: JSON.stringify({
            principalId: 'p-1',
            expectedServerInstanceId: 'stale-instance-from-prior-process',
          }),
          context: {},
          documentName: 'notes/beta',
        }),
      ).rejects.toMatchObject({ reason: 'server-instance-mismatch' });

      const warns = logCapture.getCalls('warn', '[auth-rejection]');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toBe('[auth-rejection] server-instance-mismatch');
      expect(warns[0]?.payload).toMatchObject({
        reason: 'server-instance-mismatch',
        docName: 'notes/beta',
        claimedServerInstanceId: 'stale-instance-from-prior-process',
        currentServerInstanceId: server.serverInstanceId,
      });
    } finally {
      await server.destroy();
    }
  });

  test('an accepted connection emits no rejection warn', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const authExt = getAuthExtension(server);

      await authExt.onAuthenticate({
        token: JSON.stringify({
          principalId: 'p-1',
          tabSessionId: 's-1',
          expectedBranch: 'main',
          expectedServerInstanceId: server.serverInstanceId,
        }),
        context: {},
        documentName: 'notes/gamma',
      });

      expect(logCapture.getCalls('warn', '[auth-rejection]')).toHaveLength(0);
    } finally {
      await server.destroy();
    }
  });

  test('config-doc admission denial emits a warn naming which gate fired', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'config-doc-admission-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!guard) throw new Error('expected configDocAdmissionGuard on hocuspocus.configuration');

      await expect(
        guard.onAuthenticate({
          token: undefined,
          context: {},
          documentName: '__config__/project',
          request: { socket: { remoteAddress: '203.0.113.7' }, headers: { host: 'evil.test' } },
        }),
      ).rejects.toThrow(/config-doc admission requires loopback peer/);

      const warns = logCapture.getCalls('warn', '[auth-rejection]');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.payload).toMatchObject({
        reason: 'config-doc-admission-denied',
        docName: '__config__/project',
        check: 'peer',
      });
      expect(warns[0]?.payload).not.toHaveProperty('peer');
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — config-doc admission guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-config-admission-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getConfigDocAdmissionGuard(server: Awaited<ReturnType<typeof createServer>>): {
    onAuthenticate: (payload: unknown) => Promise<void>;
  } {
    const ext = server.hocuspocus.configuration.extensions.find(
      (e) => (e as { __kind?: string }).__kind === 'config-doc-admission-guard',
    ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
    if (!ext) throw new Error('expected configDocAdmissionGuard on hocuspocus.configuration');
    return ext;
  }

  function makePayload(opts: {
    documentName: string;
    peer?: string;
    host?: string | null;
  }): unknown {
    const headers: Record<string, string> = {};
    if (opts.host !== null && opts.host !== undefined) headers.host = opts.host;
    return {
      token: undefined,
      documentName: opts.documentName,
      context: {} as Record<string, unknown>,
      request: {
        socket: opts.peer === undefined ? undefined : { remoteAddress: opts.peer },
        headers,
      },
      requestHeaders: new Headers(opts.host ? { host: opts.host } : {}),
    };
  }

  test('non-config doc bypasses the gate (no peer, no host)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: 'some-user-doc', peer: undefined, host: null }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts loopback IPv4 peer + localhost Host', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({
          documentName: '__config__/project',
          peer: '127.0.0.1',
          host: 'localhost:5173',
        }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts IPv6 loopback peer + bracketed Host', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: '__user__/config.yml', peer: '::1', host: '[::1]:5173' }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects non-loopback peer (LAN)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '192.168.1.5',
            host: 'localhost:5173',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback peer');
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects IPv4-mapped non-loopback peer', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__user__/config.yml',
            peer: '::ffff:192.168.1.5',
            host: 'localhost',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback peer');
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects loopback peer with attacker-domain Host (DNS rebinding)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '127.0.0.1',
            host: 'attacker.example.com',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback or remote Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc admits the tunnel public Host when remote access is enabled', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1'],
          externalUrl: 'https://myproject.ngrok.app',
          allowExternal: true,
          openBrowser: false,
          idleShutdown: 'off',
          loopbackOnly: true,
        },
      }),
    });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await expect(
        guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '127.0.0.1',
            host: 'myproject.ngrok.app',
          }),
        ),
      ).resolves.not.toThrow();
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: '127.0.0.1',
            host: 'attacker.example.com',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects missing Host header (no fallback to permissive accept)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({ documentName: '__config__/project', peer: '127.0.0.1', host: null }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback or remote Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts undefined peer when Host is loopback (test harness shape)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate(
        makePayload({ documentName: '__config__/project', peer: undefined, host: 'localhost' }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects attacker Host when peer is undefined (DNS rebinding with no socket)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      let thrown: unknown = null;
      try {
        await guard.onAuthenticate(
          makePayload({
            documentName: '__config__/project',
            peer: undefined,
            host: 'attacker.example.com',
          }),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect((thrown as Error).message).toContain('loopback or remote Host header');
    } finally {
      await server.destroy();
    }
  });

  test('config doc accepts loopback Host via req.headers fallback when requestHeaders absent', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const guard = getConfigDocAdmissionGuard(server);
      await guard.onAuthenticate({
        token: undefined,
        documentName: '__config__/project',
        context: {},
        request: {
          socket: { remoteAddress: '127.0.0.1' },
          headers: { host: 'localhost:5173' },
        },
      } as unknown as Parameters<typeof guard.onAuthenticate>[0]);
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — readProjectAutoSyncMode precedence', () => {
  let testProjectDir: string;
  let testHomedir: string;

  beforeEach(() => {
    testProjectDir = mkdtempSync(resolve(tmpdir(), 'ok-autosync-read-test-'));
    testHomedir = mkdtempSync(resolve(tmpdir(), 'ok-autosync-read-home-'));
  });

  afterEach(() => {
    rmSync(testProjectDir, { recursive: true, force: true });
    rmSync(testHomedir, { recursive: true, force: true });
  });

  function seedProjectLocalConfig(content: string): void {
    mkdirSync(join(testProjectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(join(testProjectDir, '.ok', LOCAL_DIR, 'config.yml'), content, 'utf-8');
  }

  function seedProjectConfig(content: string): void {
    mkdirSync(join(testProjectDir, '.ok'), { recursive: true });
    writeFileSync(join(testProjectDir, '.ok', 'config.yml'), content, 'utf-8');
  }

  test('project-local autoSync.enabled: true → engine boots enabled', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local absent + committed autoSync.default: true → engine boots enabled', async () => {
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local absent + committed autoSync.default: false → engine boots disabled', async () => {
    seedProjectConfig('autoSync:\n  default: false\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('committed autoSync.enabled is ignored (scope-mismatched) → engine boots disabled', async () => {
    seedProjectConfig('autoSync:\n  enabled: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('both absent → engine boots disabled (default)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('project-local enabled: false beats committed default: true (machine override wins)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: false\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });

  test('project-local enabled: true beats committed default: false (machine override wins)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: true\n');
    seedProjectConfig('autoSync:\n  default: false\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('project-local autoSync.enabled: null falls through to committed default: true', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: null\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('invalid project-local YAML falls through to committed default (degraded path)', async () => {
    seedProjectLocalConfig('autoSync:\n  enabled: : not-yaml [[[\n');
    seedProjectConfig('autoSync:\n  default: true\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(true);
    await srv.destroy();
  });

  test('invalid committed config defaults to disabled (degraded path)', async () => {
    seedProjectConfig('autoSync:\n  default: : not-yaml [[[\n');
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
      configHomedirOverride: testHomedir,
    });
    await srv.ready;
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);
    await srv.destroy();
  });
});

describe('createServer() — protected-branch auto-disable persistence', () => {
  test('persists autoSync.enabled=false to project-local config only', async () => {
    const projectDir = mkdtempSync(resolve(tmpdir(), 'ok-auto-disable-test-'));
    const homedir = mkdtempSync(resolve(tmpdir(), 'ok-auto-disable-home-'));
    const contentDir = mkdtempSync(resolve(projectDir, 'content-'));
    const projectConfigPath = resolveConfigPath('project', projectDir);
    const localConfigPath = resolveConfigPath('project-local', projectDir);
    mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(projectConfigPath, 'autoSync:\n  default: true\n', 'utf-8');
    writeFileSync(localConfigPath, 'autoSync:\n  enabled: true\n', 'utf-8');

    const server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      gitEnabled: false,
      configHomedirOverride: homedir,
      destroyTimeoutMs: 1_000,
    });

    try {
      await server.ready;
      const engine = server.syncEngine;
      expect(engine).not.toBeNull();
      expect(engine?.getStatus().syncEnabled).toBe(true);

      const testEngine = engine as unknown as {
        handleError: (
          classified: ReturnType<typeof classifyGitError>,
          operation: 'push' | 'pull',
        ) => void;
      };
      testEngine.handleError(
        classifyGitError(new Error('remote: error: protected branch')),
        'push',
      );

      expect(engine?.getStatus()).toMatchObject({
        state: 'disabled',
        syncEnabled: false,
        pausedReason: 'protected-branch',
        pushErrorCode: 'semantic-protected-branch',
      });
      await vi.waitFor(
        () => {
          const local = readConfigSafely({
            absPath: localConfigPath,
            sideline: false,
            warn: () => {},
          });
          expect(local.valid).toBe(true);
          expect(local.value.autoSync.enabled).toBe(false);
        },
        { timeout: 2_000, interval: 20 },
      );

      const project = readConfigSafely({
        absPath: projectConfigPath,
        sideline: false,
        warn: () => {},
      });
      expect(project.valid).toBe(true);
      expect(project.value.autoSync.default).toBe(true);
      expect(project.value.autoSync.enabled).toBeNull();
    } finally {
      await server.destroy();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homedir, { recursive: true, force: true });
    }
  });
});
describe('createServer() — phantom-doc unload', () => {
  let phantomTmpDir: string;

  beforeEach(async () => {
    phantomTmpDir = await mkdtemp(join(tmpdir(), 'ok-phantom-unload-'));
  });

  afterEach(async () => {
    await rm(phantomTmpDir, { recursive: true, force: true });
  });

  async function waitForUnload(
    server: ServerInstance,
    docName: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!server.hocuspocus.documents.has(docName)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !server.hocuspocus.documents.has(docName);
  }

  test('phantom doc (no on-disk file, no content) unloads after last disconnect', async () => {
    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 50,
      maxDebounce: 100,
    });
    try {
      await server.ready;

      const docName = 'never-on-disk';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
      await conn.disconnect();

      const unloaded = await waitForUnload(server, docName, 2_000);
      expect(unloaded).toBe(true);
    } finally {
      await server.destroy();
    }
  });

  test('file-backed doc stays resident after disconnect', async () => {
    const docName = 'on-disk';
    writeFileSync(join(phantomTmpDir, `${docName}.md`), '# hello\n', 'utf-8');

    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 50,
      maxDebounce: 100,
    });
    try {
      await server.ready;

      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
      await conn.disconnect();

      const controlName = 'phantom-control';
      const controlConn = await server.hocuspocus.openDirectConnection(controlName);
      await controlConn.disconnect();
      const controlUnloaded = await waitForUnload(server, controlName, 2_000);
      expect(controlUnloaded).toBe(true);

      expect(server.hocuspocus.documents.has(docName)).toBe(true);
    } finally {
      await server.destroy();
    }
  }, 15_000);

  test('transient doc with CRDT content but no disk file stays resident', async () => {
    const server = createServer({
      contentDir: phantomTmpDir,
      projectDir: phantomTmpDir,
      quiet: true,
      debounce: 60_000,
      maxDebounce: 60_000,
    });
    try {
      await server.ready;

      const docName = 'transient-with-content';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await conn.transact((doc) => {
        doc.getText('source').insert(0, 'user-typed-content\n');
      });
      await conn.disconnect();

      await new Promise((r) => setTimeout(r, 200));
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — shouldUnloadDocument forceUnloadSet branched guard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-shouldunload-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('force-unload via delete-path unloads document despite live in-process connection and non-empty content', async () => {
    const docName = 'force-unload-target';
    writeFileSync(join(tmpDir, `${docName}.md`), '# initial-content\n', 'utf-8');

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });

    let localHttp: import('node:http').Server | undefined;
    try {
      await server.ready;

      const conn = await server.hocuspocus.openDirectConnection(docName);
      expect(server.hocuspocus.documents.has(docName)).toBe(true);

      await conn.transact((doc) => {
        const ytext = doc.getText('source');
        ytext.insert(0, 'pending-bytes');
      });
      const doc = server.hocuspocus.documents.get(docName);
      if (!doc) throw new Error('document missing after transact');
      expect(doc.getText('source').toString().length).toBeGreaterThan(0);

      const apiExt = server.hocuspocus.configuration.extensions.find(
        (e: unknown) =>
          typeof (e as { onRequest?: unknown }).onRequest === 'function' &&
          (e as { priority?: number }).priority === 100,
      ) as
        | {
            onRequest: (ctx: {
              request: import('node:http').IncomingMessage;
              response: import('node:http').ServerResponse;
            }) => Promise<void>;
          }
        | undefined;
      if (!apiExt) throw new Error('api-extension not found in extensions array');

      const { createServer: createNodeHttp } = await import('node:http');
      const nativeApi = server.nativeApi;
      localHttp = createNodeHttp((req, res) => {
        void (async () => {
          if (await nativeApi.dispatch(req, res)) return;
          await apiExt.onRequest({ request: req, response: res });
        })();
      });
      await new Promise<void>((resolve) => localHttp?.listen(0, '127.0.0.1', resolve));
      const address = localHttp.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('local HTTP server did not bind to a port');
      }
      const baseURL = `http://127.0.0.1:${address.port}`;

      const res = await fetch(`${baseURL}/api/delete-path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'file', path: docName }),
      });
      expect(res.status).toBe(200);

      expect(server.hocuspocus.documents.has(docName)).toBe(false);
    } finally {
      if (localHttp) {
        await new Promise<void>((resolve, reject) =>
          localHttp?.close((err) => (err ? reject(err) : resolve())),
        );
      }
      await server.destroy();
    }
  });
});

describe('createServer() — removalRedirectGuard registration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-removal-redirect-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('extension is registered with __kind: removal-redirect-guard', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate?: (payload: unknown) => Promise<void> } | undefined;
      expect(ext).toBeDefined();
      expect(typeof ext?.onAuthenticate).toBe('function');
    } finally {
      await server.destroy();
    }
  });

  test('extension order: after configDocAdmissionGuard, before apiExtension', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const exts = server.hocuspocus.configuration.extensions;
      const idx = (kind: string): number =>
        exts.findIndex((e) => (e as { __kind?: string }).__kind === kind);
      const principal = idx('principal-auth');
      const configGuard = idx('config-doc-admission-guard');
      const removal = idx('removal-redirect-guard');
      expect(principal).toBeGreaterThan(-1);
      expect(configGuard).toBeGreaterThan(principal);
      expect(removal).toBeGreaterThan(configGuard);
    } finally {
      await server.destroy();
    }
  });

  test('onAuthenticate admits a fresh docName (no file, no cache state)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');
      let thrown: unknown = null;
      try {
        await ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: 'fresh-doc',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
    } finally {
      await server.destroy();
    }
  });

  test('onAuthenticate is a no-op for system docs (cache lookup never happens)', async () => {
    const server = createServer({ contentDir: tmpDir, projectDir: tmpDir, quiet: true });
    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (e) => (e as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');
      let thrown: unknown = null;
      try {
        await ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: '__system__',
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
    } finally {
      await server.destroy();
    }
  });

  test('warm backlink reconciliation arms deletion rejection for a file removed offline', async () => {
    writeFileSync(join(tmpDir, 'removed-offline.md'), '# Removed offline\n', 'utf-8');
    const first = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      gitEnabled: false,
    });
    await first.ready;
    await first.destroy();
    releaseServerLock(first.lockDir);
    unlinkSync(join(tmpDir, 'removed-offline.md'));

    const restarted = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      gitEnabled: false,
    });
    try {
      await restarted.ready;
      const ext = restarted.hocuspocus.configuration.extensions.find(
        (entry) => (entry as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');

      await expect(
        ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: 'removed-offline',
        }),
      ).rejects.toMatchObject({ reason: 'doc-deleted' });
    } finally {
      await restarted.destroy();
    }
  });

  test('warm removal journal preserves rename redirects', async () => {
    writeFileSync(join(tmpDir, 'renamed-source.md'), '# Renamed source\n', 'utf-8');
    const first = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      gitEnabled: false,
    });
    await first.ready;
    await first.destroy();
    releaseServerLock(first.lockDir);
    unlinkSync(join(tmpDir, 'renamed-source.md'));
    writeFileSync(join(tmpDir, 'renamed-target.md'), '# Renamed target\n', 'utf-8');
    saveRemovedDocsJournal(tmpDir, [
      [
        'renamed-source',
        {
          kind: 'renamed',
          newDocName: 'renamed-target',
          addedAt: Date.now(),
        },
      ],
    ]);
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      gitEnabled: false,
    });

    try {
      await server.ready;
      const ext = server.hocuspocus.configuration.extensions.find(
        (entry) => (entry as { __kind?: string }).__kind === 'removal-redirect-guard',
      ) as { onAuthenticate: (payload: unknown) => Promise<void> } | undefined;
      if (!ext) throw new Error('removal-redirect-guard not registered');

      await expect(
        ext.onAuthenticate({
          token: undefined,
          context: {},
          documentName: 'renamed-source',
        }),
      ).rejects.toMatchObject({ reason: 'rename-redirect:renamed-target' });
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — push-permission auth wiring', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-wiring-'));
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(tmpDir, 'README.md'), 'seed\n', 'utf-8');
    await git.add('.');
    await git.commit('seed');
    await git.addRemote('origin', 'https://github.com/inkeep/open-knowledge.git');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('forwards detectGh + tokenStore through createServer → SyncEngine → probe call', async () => {
    const detectGhStub: DetectGhFn = (host?: string) => ({
      available: true,
      token: `stub-token-for-${host ?? 'github.com'}`,
    });
    const tokenStoreStub: ProbeTokenStore = {
      async get(host: string) {
        return { token: `store-token-for-${host}` };
      },
    };
    const detectGhAccountsStub: DetectGhAccountsFn = () => [{ login: 'stub', active: true }];

    const probeCalls: CheckPushPermissionOptions[] = [];
    const probeSpy = async (opts: CheckPushPermissionOptions): Promise<PushPermission> => {
      probeCalls.push(opts);
      return { kind: 'allowed' };
    };

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
      destroyTimeoutMs: 1_000,
      detectGh: detectGhStub,
      detectGhAccounts: detectGhAccountsStub,
      tokenStore: tokenStoreStub,
      checkPushPermissionFn: probeSpy,
    });

    try {
      await server.ready;
      expect(server.syncEngine).not.toBeNull();

      await server.syncEngine?.refreshPushPermission();

      expect(probeCalls.length).toBeGreaterThan(0);
      const firstCall = probeCalls[0];
      expect(firstCall.detectGh).toBe(detectGhStub);
      expect(firstCall.detectGhAccounts).toBe(detectGhAccountsStub);
      expect(firstCall.tokenStore).toBe(tokenStoreStub);
      expect(firstCall.owner).toBe('inkeep');
      expect(firstCall.repo).toBe('open-knowledge');
    } finally {
      await server.destroy();
    }
  });

  test('omitting detectGh + tokenStore leaves the probe call with undefined seams (no silent default substitution)', async () => {
    const probeCalls: CheckPushPermissionOptions[] = [];
    const probeSpy = async (opts: CheckPushPermissionOptions): Promise<PushPermission> => {
      probeCalls.push(opts);
      return { kind: 'allowed' };
    };

    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
      destroyTimeoutMs: 1_000,
      checkPushPermissionFn: probeSpy,
    });

    try {
      await server.ready;
      await server.syncEngine?.refreshPushPermission();
      expect(probeCalls.length).toBeGreaterThan(0);
      expect(probeCalls[0].detectGh).toBeUndefined();
      expect(probeCalls[0].tokenStore).toBeUndefined();
    } finally {
      await server.destroy();
    }
  });
});

describe('createServer() — generated index wiring', () => {
  let projectDir: string;
  let contentDir: string;
  let server: ServerInstance | null;
  let shadowHandle: Awaited<ReturnType<typeof initShadowRepo>>;
  let localHttp: import('node:http').Server | null = null;

  const indexPath = () => join(contentDir, 'index.md');
  const readIndex = () => readFileSync(indexPath(), 'utf-8');

  const indexPathAt = (dir: string) => join(contentDir, dir, 'index.md');
  const readIndexAt = (dir: string) => readFileSync(indexPathAt(dir), 'utf-8');
  async function waitForIndexAt(
    dir: string,
    predicate: (markdown: string) => boolean,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        expect(existsSync(indexPathAt(dir))).toBe(true);
        expect(predicate(readIndexAt(dir))).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );
  }

  function writeDoc(rel: string, title: string, type = 'note', description?: string): void {
    const fm = [
      `title: ${title}`,
      `type: ${type}`,
      ...(description ? [`description: ${description}`] : []),
    ];
    mkdirSync(join(contentDir, rel, '..'), { recursive: true });
    writeFileSync(join(contentDir, rel), `---\n${fm.join('\n')}\n---\n\n# ${title}\n`, 'utf-8');
  }

  async function waitForIndex(predicate: (markdown: string) => boolean): Promise<void> {
    await vi.waitFor(
      () => {
        expect(existsSync(indexPath())).toBe(true);
        expect(predicate(readIndex())).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );
  }

  async function bootServer(): Promise<ServerInstance> {
    await ensureProjectGit(projectDir);
    await prepareGeneratedIndexGitAttributes();
    shadowHandle = await initShadowRepo(projectDir);
    server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      shadowRepo: shadowHandle,
      skipStateManifestCheck: true,
    });
    await server.ready;
    await server.generatedIndexSweepReady;
    return server;
  }

  async function startServerWithIndexHooks(
    generatedIndexTestHooks: NonNullable<
      Parameters<typeof createServer>[0]['generatedIndexTestHooks']
    >,
  ): Promise<ServerInstance> {
    await ensureProjectGit(projectDir);
    await prepareGeneratedIndexGitAttributes();
    shadowHandle = await initShadowRepo(projectDir);
    server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      shadowRepo: shadowHandle,
      skipStateManifestCheck: true,
      generatedIndexTestHooks,
    });
    return server;
  }

  async function prepareGeneratedIndexGitAttributes(): Promise<void> {
    const config = readConfigSafely({
      absPath: resolveConfigPath('project', projectDir),
      sideline: false,
    });
    if (config.value.contentRules?.okf?.generate?.index !== true) return;
    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames: ['index'],
      enabled: true,
    });
    expect(result.ok).toBe(true);
  }

  async function apiBaseUrl(): Promise<string> {
    const apiExt = server?.hocuspocus.configuration.extensions.find(
      (e: unknown) =>
        typeof (e as { onRequest?: unknown }).onRequest === 'function' &&
        (e as { priority?: number }).priority === 100,
    ) as
      | {
          onRequest: (ctx: {
            request: import('node:http').IncomingMessage;
            response: import('node:http').ServerResponse;
          }) => Promise<void>;
        }
      | undefined;
    if (!apiExt) throw new Error('api-extension not found in extensions array');

    const { createServer: createNodeHttp } = await import('node:http');
    const nativeApi = server?.nativeApi;
    localHttp = createNodeHttp((req, res) => {
      void (async () => {
        if (nativeApi !== undefined && (await nativeApi.dispatch(req, res))) return;
        await apiExt.onRequest({ request: req, response: res });
      })();
    });
    await new Promise<void>((resolve) => localHttp?.listen(0, '127.0.0.1', resolve));
    const address = localHttp.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('local HTTP server did not bind to a port');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function agentWriteMd(baseUrl: string, docName: string, markdown: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docName, markdown, position: 'replace' }),
    });
    const body = await res.text();
    expect(res.status, body).toBe(200);
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ok-index-wiring-'));
    contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      stringifyYaml({ contentRules: { okf: { enabled: true, generate: { index: true } } } }),
      'utf-8',
    );
    server = null;
  });

  afterEach(async () => {
    if (localHttp) {
      await new Promise<void>((resolve, reject) =>
        localHttp?.close((err) => (err ? reject(err) : resolve())),
      );
      localHttp = null;
    }
    await server?.destroy();
    loggerFactory.reset();
    await rm(projectDir, { recursive: true, force: true });
  });

  test('the setting reaches the server through the real config file', async () => {
    await bootServer();
    writeDoc('note.md', 'A note', 'note', 'Something to index.');

    await waitForIndex((md) => md.includes('A note'));
    expect(readIndex()).toContain('okf_version: "0.2"');
  });

  test('generated metadata warnings identify the production content directory', async () => {
    const logs = captureAllLoggers();
    writeDoc('warning.md', 'Parser\ue102warning', 'note');

    await bootServer();

    expect(logs.getLoggerEntries('generated-index')).toEqual([
      {
        level: 'warn',
        msg: 'generated index metadata contained a parser-reserved private-use code point; replaced it with U+FFFD',
        payload: { contentDir, path: 'warning.md', field: 'title', kind: 'parser-reservation' },
      },
    ]);
  });

  test('server readiness settles before the boot index sweep starts planning', async () => {
    writeDoc('existing.md', 'Existing at boot', 'note');

    let enterPlanning!: () => void;
    const planningEntered = new Promise<void>((resolve) => {
      enterPlanning = resolve;
    });
    let releasePlanning!: () => void;
    const planningBarrier = new Promise<void>((resolve) => {
      releasePlanning = resolve;
    });
    let readySettled = false;

    const activeServer = await startServerWithIndexHooks({
      beforePlan: async ({ fullSweep }) => {
        if (!fullSweep) return;
        enterPlanning();
        await planningBarrier;
      },
    });
    void activeServer.ready.then(() => {
      readySettled = true;
    });
    let sweepSettled = false;
    void activeServer.generatedIndexSweepReady.then(() => {
      sweepSettled = true;
    });

    await planningEntered;
    expect(readySettled).toBe(true);
    expect(sweepSettled).toBe(false);
    expect(existsSync(indexPath())).toBe(false);

    releasePlanning();
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'completed',
      indexCount: 1,
    });
    expect(existsSync(indexPath())).toBe(true);
    expect(readIndex()).toContain('* [Existing at boot](./existing.md)');
  });

  test('a non-fatal boot sweep error reports a failed settlement', async () => {
    const activeServer = await startServerWithIndexHooks({
      beforePlan: () => {
        throw new Error('injected generated-index failure');
      },
    });

    await expect(activeServer.ready).resolves.toBeUndefined();
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'failed',
      indexCount: 0,
    });
  });

  test('disabling generation stops an in-flight sweep before its next write', async () => {
    writeDoc('alpha/a.md', 'Alpha', 'note');
    writeDoc('beta/b.md', 'Beta', 'note');

    const preservedRoot = '# Existing root index\n';
    const preservedBeta = '# Existing beta index\n';
    writeFileSync(indexPath(), preservedRoot, 'utf-8');
    writeFileSync(indexPathAt('beta'), preservedBeta, 'utf-8');
    const rootMtime = statSync(indexPath()).mtimeMs;
    const betaMtime = statSync(indexPathAt('beta')).mtimeMs;

    let firstWriteFinished!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteFinished = resolve;
    });
    let releaseFirstWrite!: () => void;
    const firstWriteBarrier = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let paused = false;

    const activeServer = await startServerWithIndexHooks({
      afterWrite: async ({ docName }) => {
        if (paused || docName !== 'alpha/index') return;
        paused = true;
        firstWriteFinished();
        await firstWriteBarrier;
      },
    });
    await activeServer.ready;
    await firstWrite;

    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      stringifyYaml({ contentRules: { okf: { enabled: true, generate: { index: false } } } }),
      'utf-8',
    );
    releaseFirstWrite();

    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'disabled',
      indexCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(existsSync(indexPathAt('alpha'))).toBe(true);
    expect(readIndex()).toBe(preservedRoot);
    expect(readIndexAt('beta')).toBe(preservedBeta);
    expect(statSync(indexPath()).mtimeMs).toBe(rootMtime);
    expect(statSync(indexPathAt('beta')).mtimeMs).toBe(betaMtime);

    writeDoc('beta/after-disable.md', 'After disable', 'note');
    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(readIndex()).toBe(preservedRoot);
    expect(readIndexAt('beta')).toBe(preservedBeta);
    expect(statSync(indexPath()).mtimeMs).toBe(rootMtime);
    expect(statSync(indexPathAt('beta')).mtimeMs).toBe(betaMtime);
  });

  test('boot sweep readiness waits for live requests coalesced behind it', async () => {
    writeDoc('anchor.md', 'Anchor', 'note');

    let firstPassEntered!: () => void;
    const firstPassStarted = new Promise<void>((resolve) => {
      firstPassEntered = resolve;
    });
    let releaseFirstPass!: () => void;
    const firstPassBarrier = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    let coordinatorIdle!: () => void;
    const coordinatorSettled = new Promise<void>((resolve) => {
      coordinatorIdle = resolve;
    });
    let blockedKickObserved!: () => void;
    const followupDeferredBySingleFlight = new Promise<void>((resolve) => {
      blockedKickObserved = resolve;
    });
    let passCount = 0;

    const activeServer = await startServerWithIndexHooks({
      beforePlan: async () => {
        passCount++;
        if (passCount !== 1) return;
        firstPassEntered();
        await firstPassBarrier;
      },
      onIdle: () => {
        if (passCount === 2) coordinatorIdle();
      },
      onKickWhileInFlight: blockedKickObserved,
    });
    await activeServer.ready;
    await firstPassStarted;
    let sweepSettled = false;
    void activeServer.generatedIndexSweepReady.then(() => {
      sweepSettled = true;
    });
    const baseUrl = await apiBaseUrl();

    await agentWriteMd(baseUrl, 'one', '---\ntitle: One\ntype: note\n---\n\n# One\n');
    await agentWriteMd(baseUrl, 'two', '---\ntitle: Two\ntype: note\n---\n\n# Two\n');
    await agentWriteMd(baseUrl, 'three', '---\ntitle: Three\ntype: note\n---\n\n# Three\n');

    await followupDeferredBySingleFlight;
    expect(passCount).toBe(1);
    releaseFirstPass();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sweepSettled).toBe(false);
    await coordinatorSettled;
    await expect(activeServer.generatedIndexSweepReady).resolves.toMatchObject({
      status: 'completed',
    });

    expect(passCount).toBe(2);
    expect(readIndex()).toContain('* [One](./one.md)');
    expect(readIndex()).toContain('* [Two](./two.md)');
    expect(readIndex()).toContain('* [Three](./three.md)');
  });

  test('destroy cancels and drains an in-flight generated-index write', async () => {
    writeDoc('deep/note.md', 'Deep note', 'note');

    let writePaused!: () => void;
    const firstWritePaused = new Promise<void>((resolve) => {
      writePaused = resolve;
    });
    let releaseWrite!: () => void;
    const writeBarrier = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let abortObserved!: () => void;
    const regenerationAborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    let blocked = false;

    const activeServer = await startServerWithIndexHooks({
      afterWrite: async ({ signal }) => {
        if (blocked) return;
        blocked = true;
        signal.addEventListener('abort', abortObserved, { once: true });
        writePaused();
        await writeBarrier;
      },
    });
    await activeServer.ready;
    await firstWritePaused;

    let destroySettled = false;
    const destroying = activeServer.destroy().then(() => {
      destroySettled = true;
    });
    await regenerationAborted;
    expect(destroySettled).toBe(false);
    expect(existsSync(indexPathAt('deep'))).toBe(true);
    expect(existsSync(indexPath())).toBe(false);

    releaseWrite();
    await destroying;
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'cancelled',
      indexCount: 1,
    });
    expect(existsSync(indexPath())).toBe(false);
  });

  test('creating a document lands its entry in its own folder index', async () => {
    await bootServer();
    writeDoc('concepts/first.md', 'First', 'concept');
    await waitForIndexAt('concepts', (md) => md.includes('* [First](./first.md)'));
    await waitForIndex((md) => md.includes('* [concepts](./concepts/index.md)'));
    expect(readIndex()).not.toContain('./concepts/first.md');

    writeDoc('concepts/second.md', 'Second', 'concept');
    await waitForIndexAt('concepts', (md) => md.includes('* [Second](./second.md)'));
    expect(readIndexAt('concepts')).toContain('* [First](./first.md)');
  });

  test('an external metadata update refreshes the existing entry', async () => {
    writeDoc('note.md', 'Before', 'note', 'Old description');
    await bootServer();
    await waitForIndex((md) => md.includes('[Before]'));

    writeDoc('note.md', 'After', 'concept', 'New description');

    await waitForIndex(
      (md) =>
        md.includes('# concept') &&
        md.includes('[After]') &&
        md.includes('New description') &&
        !md.includes('[Before]'),
    );
  });

  test('settings endpoint commits the Git rule and config as one lifecycle operation', async () => {
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      stringifyYaml({ contentRules: { okf: { enabled: true, generate: { index: false } } } }),
      'utf-8',
    );
    writeDoc('waiting.md', 'Waiting', 'note');
    const activeServer = await bootServer();
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'disabled',
      indexCount: 0,
    });
    expect(existsSync(indexPath())).toBe(false);
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);

    const baseUrl = await apiBaseUrl();
    const enabled = await fetch(`${baseUrl}/api/generated-index/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      enabled: true,
      active: true,
      applied: true,
      git: { state: 'ready', ownership: 'open-knowledge' },
    });

    await waitForIndex((md) => md.includes('[Waiting]'));
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toContain(
      '/content/**/index.md merge=union',
    );

    const indexBeforeDisable = readIndex();
    const disabled = await fetch(`${baseUrl}/api/generated-index/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      enabled: false,
      active: false,
      applied: true,
    });
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);
    expect(readIndex()).toBe(indexBeforeDisable);
  });

  test('settings endpoint rolls the Git rule back when the config write is rejected', async () => {
    const invalidConfig = 'contentRules: [\n';
    writeFileSync(join(projectDir, '.ok', 'config.yml'), invalidConfig, 'utf-8');
    writeDoc('waiting.md', 'Waiting', 'note');
    const activeServer = await bootServer();
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'disabled',
      indexCount: 0,
    });

    const response = await fetch(`${await apiBaseUrl()}/api/generated-index/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      active: false,
      applied: false,
      reason: 'config-write',
      git: { state: 'missing' },
    });
    expect(readFileSync(join(projectDir, '.ok', 'config.yml'), 'utf-8')).toBe(invalidConfig);
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);
    expect(existsSync(indexPath())).toBe(false);
  });

  test('settings endpoint repairs a missing Git rule when config is already enabled', async () => {
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      stringifyYaml({ contentRules: { okf: { enabled: true, generate: { index: true } } } }),
      'utf-8',
    );
    const activeServer = await bootServer();
    await activeServer.generatedIndexSweepReady;
    unlinkSync(join(projectDir, '.gitattributes'));
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);

    const response = await fetch(`${await apiBaseUrl()}/api/generated-index/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      active: true,
      applied: true,
      git: { state: 'ready', ownership: 'open-knowledge' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toContain(
      '/content/**/index.md merge=union',
    );
  });

  test('external Git-attribute drift pauses regeneration and resumes after repair', async () => {
    const logCapture = captureAllLoggers();
    await bootServer();
    writeDoc('note.md', 'Before drift', 'note');
    await waitForIndex((md) => md.includes('[Before drift]'));
    const preservedIndex = readIndex();
    const preservedMtime = statSync(indexPath()).mtimeMs;

    writeFileSync(
      join(projectDir, '.gitattributes'),
      '/content/index.md merge=ours\n/content/**/index.md merge=ours\n',
      'utf-8',
    );
    writeDoc('note.md', 'Blocked by drift', 'note');

    await vi.waitFor(
      () => {
        expect(
          logCapture
            .getCalls('warn', 'generated index regeneration paused by Git attributes')
            .some((entry) => entry.payload.state === 'conflict'),
        ).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(readIndex()).toBe(preservedIndex);
    expect(statSync(indexPath()).mtimeMs).toBe(preservedMtime);

    const pausedStatus = await fetch(`${await apiBaseUrl()}/api/generated-index/settings`);
    expect(pausedStatus.status).toBe(200);
    await expect(pausedStatus.json()).resolves.toMatchObject({
      enabled: true,
      active: false,
      git: { state: 'conflict' },
    });

    unlinkSync(join(projectDir, '.gitattributes'));
    const repaired = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames: ['index'],
      enabled: true,
    });
    expect(repaired.ok).toBe(true);

    writeDoc('note.md', 'Recovered after repair', 'note');
    await waitForIndex(
      (md) => md.includes('[Recovered after repair]') && !md.includes('[Before drift]'),
    );
  });

  test('deleting an unopened document removes its entry from its folder index', async () => {
    await bootServer();
    writeDoc('concepts/doomed.md', 'Doomed', 'concept');
    writeDoc('concepts/survivor.md', 'Survivor', 'concept');
    await waitForIndexAt('concepts', (md) => md.includes('./doomed.md'));

    unlinkSync(join(contentDir, 'concepts', 'doomed.md'));

    await waitForIndexAt('concepts', (md) => !md.includes('./doomed.md'));
    expect(readIndexAt('concepts')).toContain('./survivor.md');
  });

  test('an emptied section disappears rather than lingering as a bare heading', async () => {
    await bootServer();
    writeDoc('only.md', 'Only', 'solo-type');
    writeDoc('keep.md', 'Keep', 'note');
    await waitForIndex((md) => md.includes('## solo\\-type'));

    unlinkSync(join(contentDir, 'only.md'));

    await waitForIndex((md) => !md.includes('## solo\\-type'));
    expect(readIndex()).toContain('## note');
  });

  test('a cross-directory rename through the watcher drops the source entry and lands the destination', async () => {
    writeDoc('concepts/mover.md', 'Mover', 'concept');
    writeDoc('concepts/keeper.md', 'Keeper', 'concept');
    writeDoc('archive/anchor.md', 'Anchor', 'note');
    await bootServer();
    await waitForIndexAt('concepts', (md) => md.includes('./mover.md'));
    await waitForIndexAt('archive', (md) => md.includes('./anchor.md'));

    renameSync(join(contentDir, 'concepts', 'mover.md'), join(contentDir, 'archive', 'mover.md'));

    await waitForIndexAt('archive', (md) => md.includes('./mover.md'));
    await waitForIndexAt(
      'concepts',
      (md) => !md.includes('./mover.md') && md.includes('./keeper.md'),
    );
  });

  test('moving a directory last admitted document preserves its orphan index', async () => {
    writeDoc('source/only.md', 'Only', 'note');
    writeDoc('destination/anchor.md', 'Anchor', 'note');
    await bootServer();
    await server?.generatedIndexSweepReady;
    await waitForIndex(
      (md) => md.includes('./source/index.md') && md.includes('./destination/index.md'),
    );

    const orphanBytes = readIndexAt('source');
    const orphanMtime = statSync(indexPathAt('source')).mtimeMs;

    renameSync(join(contentDir, 'source', 'only.md'), join(contentDir, 'destination', 'only.md'));

    await waitForIndexAt(
      'destination',
      (md) => md.includes('./only.md') && md.includes('./anchor.md'),
    );
    await waitForIndex(
      (md) => !md.includes('./source/index.md') && md.includes('./destination/index.md'),
    );
    expect(readIndexAt('source')).toBe(orphanBytes);
    expect(statSync(indexPathAt('source')).mtimeMs).toBe(orphanMtime);
  });

  test('a rebuild lands on the ok-generator ref, not a human or service writer', async () => {
    await bootServer();
    writeDoc('note.md', 'A note', 'note', 'Something to index.');
    await waitForIndex((md) => md.includes('A note'));

    const sg = shadowGit(shadowHandle);
    await vi.waitFor(
      async () => {
        const out = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
        expect(out).toContain('ok-generator');
      },
      { timeout: 20_000, interval: 100 },
    );
  });

  test('logs one bounded written outcome for every attempted boot decision', async () => {
    const logCapture = captureAllLoggers();
    writeDoc('concepts/first.md', 'First', 'concept');

    await bootServer();

    const events = logCapture
      .getCalls()
      .filter((entry) => entry.payload.event === 'generated-index-regeneration');
    expect(events.map((entry) => entry.payload)).toEqual([
      { event: 'generated-index-regeneration', outcome: 'written', directory: 'concepts' },
      { event: 'generated-index-regeneration', outcome: 'written', directory: '' },
    ]);
  });

  test('a rebuild that computes identical bytes performs no write', async () => {
    const logCapture = captureAllLoggers();
    await bootServer();
    writeDoc('note.md', 'A note', 'note', 'A description.');
    await waitForIndex((md) => md.includes('A note'));
    const regenerationEvents = () =>
      logCapture
        .getCalls()
        .filter((entry) => entry.payload.event === 'generated-index-regeneration');
    const baselineEventCount = regenerationEvents().length;

    const settled = statSync(indexPath()).mtimeMs;
    const bytes = readIndex();

    writeFileSync(join(contentDir, 'log.md'), '# Log\n\n## 2026-08-05\n\n- An entry.\n', 'utf-8');

    await vi.waitFor(
      () => {
        expect(
          regenerationEvents()
            .slice(baselineEventCount)
            .map((entry) => entry.payload),
        ).toEqual([{ event: 'generated-index-regeneration', outcome: 'unchanged', directory: '' }]);
      },
      { timeout: 20_000, interval: 50 },
    );

    expect(readIndex()).toBe(bytes);
    expect(statSync(indexPath()).mtimeMs).toBe(settled);
  });

  test('an unopened tracked index conflict preserves exact bytes until resolution', async () => {
    writeDoc('concepts/first.md', 'First', 'concept');
    const conflicted = [
      '<<<<<<< HEAD',
      '# Mine',
      '=======',
      '# Theirs',
      '>>>>>>> incoming',
      '',
    ].join('\n');
    writeFileSync(indexPathAt('concepts'), conflicted, 'utf-8');
    mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', LOCAL_DIR, 'conflicts.json'),
      JSON.stringify({
        version: 1,
        branch: 'main',
        conflicts: [
          {
            kind: 'reconcile',
            file: 'content/concepts/index.md',
            detectedAt: '2026-08-07T00:00:00.000Z',
            reason: 'disk-markers',
            stages: { base: '', ours: '', theirs: conflicted },
          },
        ],
      }),
      'utf-8',
    );
    const conflictedMtime = statSync(indexPathAt('concepts')).mtimeMs;

    const logCapture = captureAllLoggers();
    await bootServer();
    expect(server?.hocuspocus.documents.has('concepts/index')).toBe(false);
    expect(server?.conflicts.list()).toEqual([
      expect.objectContaining({ kind: 'reconcile', file: 'content/concepts/index.md' }),
    ]);

    writeFileSync(
      join(contentDir, 'concepts', 'log.md'),
      '# Log\n\n## 2026-08-06\n\n- Trigger regeneration.\n',
      'utf-8',
    );

    await vi.waitFor(
      () => {
        expect(
          logCapture
            .getCalls('warn', 'generated index regeneration blocked by active conflict')
            .some((entry) => entry.payload.directory === 'concepts'),
        ).toBe(true);
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(readIndexAt('concepts')).toBe(conflicted);
    expect(statSync(indexPathAt('concepts')).mtimeMs).toBe(conflictedMtime);

    server?.conflicts.dissolveReconcile('concepts/index');
    expect(server?.conflicts.list()).toEqual([]);
    writeDoc('concepts/second.md', 'Second', 'concept');
    await waitForIndexAt(
      'concepts',
      (md) => md.includes('* [First](./first.md)') && md.includes('* [Second](./second.md)'),
    );
    expect(readIndexAt('concepts')).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });

  test('a live index conflict blocks regeneration until the conflict is resolved', async () => {
    const logCapture = captureAllLoggers();
    await bootServer();
    writeDoc('concepts/first.md', 'First', 'concept');
    await waitForIndexAt('concepts', (md) => md.includes('* [First](./first.md)'));
    await waitForIndex((md) => md.includes('* [concepts](./concepts/index.md)'));

    const canonical = readIndexAt('concepts');
    const connection = await server?.hocuspocus.openDirectConnection('concepts/index');
    const document = server?.hocuspocus.documents.get('concepts/index');
    expect(document).toBeDefined();
    expect(document?.getText('source').toString()).toBe(canonical);

    const conflicted = [
      '<<<<<<< HEAD',
      canonical.trimEnd(),
      '=======',
      canonical.replace('[First]', '[Conflicted first]').trimEnd(),
      '>>>>>>> incoming',
      '',
    ].join('\n');
    writeFileSync(indexPathAt('concepts'), conflicted, 'utf-8');

    await vi.waitFor(
      () => {
        expect(server?.conflicts.findByDocName('concepts/index')).toMatchObject({
          kind: 'reconcile',
          reason: 'disk-markers',
        });
      },
      { timeout: 20_000, interval: 50 },
    );

    const regenerationEvents = () =>
      logCapture
        .getCalls()
        .filter((entry) => entry.payload.event === 'generated-index-regeneration');
    const baselineEventCount = regenerationEvents().length;
    writeDoc('concepts/second.md', 'Second', 'concept');

    await vi.waitFor(
      () => {
        expect(regenerationEvents().slice(baselineEventCount)).toEqual([
          {
            level: 'warn',
            msg: '[index] generated index regeneration blocked by active conflict',
            payload: {
              event: 'generated-index-regeneration',
              outcome: 'blocked',
              directory: 'concepts',
              reason: 'conflict',
            },
          },
          {
            level: 'info',
            msg: '[index] generated index regeneration completed',
            payload: {
              event: 'generated-index-regeneration',
              outcome: 'unchanged',
              directory: '',
            },
          },
        ]);
      },
      { timeout: 20_000, interval: 50 },
    );

    expect(readIndexAt('concepts')).toBe(conflicted);
    expect(document?.getText('source').toString()).toBe(canonical);
    expect(server?.conflicts.findByDocName('concepts/index')).toMatchObject({
      kind: 'reconcile',
      reason: 'disk-markers',
    });

    writeFileSync(indexPathAt('concepts'), canonical, 'utf-8');
    await vi.waitFor(
      () => {
        expect(server?.conflicts.findByDocName('concepts/index')).toBeUndefined();
      },
      { timeout: 20_000, interval: 50 },
    );

    writeDoc('concepts/third.md', 'Third', 'concept');
    await waitForIndexAt(
      'concepts',
      (md) => md.includes('./second.md') && md.includes('./third.md'),
    );
    expect(readIndexAt('concepts')).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);

    await connection?.disconnect();
  });

  test('a rebuild reaches an open document THROUGH the CRDT, not behind its back', async () => {
    const logCapture = captureAllLoggers();
    await bootServer();
    writeDoc('first.md', 'First', 'note');
    await waitForIndex((md) => md.includes('./first.md'));

    const conn = await server?.hocuspocus.openDirectConnection('index');
    const doc = server?.hocuspocus.documents.get('index');
    expect(doc).toBeDefined();

    const origins: unknown[] = [];
    doc?.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));
    const regenerationEvents = () =>
      logCapture
        .getCalls()
        .filter((entry) => entry.payload.event === 'generated-index-regeneration');
    const baselineEventCount = regenerationEvents().length;

    writeDoc('second.md', 'Second', 'note');

    await vi.waitFor(
      () => {
        const live = doc?.getText('source').toString() ?? '';
        expect(live).toContain('./second.md');
        expect(live).toContain('./first.md');
      },
      { timeout: 20_000, interval: 50 },
    );

    const viaGenerator = origins.some(
      (o) =>
        typeof o === 'object' &&
        o !== null &&
        (o as { context?: { origin?: string } }).context?.origin === 'generated-index',
    );
    expect(viaGenerator).toBe(true);
    expect(
      regenerationEvents()
        .slice(baselineEventCount)
        .map((entry) => entry.payload),
    ).toEqual([{ event: 'generated-index-regeneration', outcome: 'written', directory: '' }]);

    await conn?.disconnect();
  });

  test('a document edit rebuilds only its own folder index, not a sibling', async () => {
    await bootServer();
    writeDoc('alpha/a.md', 'A one', 'note');
    writeDoc('beta/b.md', 'B one', 'note');
    await waitForIndexAt('alpha', (md) => md.includes('[A one]'));
    await waitForIndexAt('beta', (md) => md.includes('[B one]'));

    const betaBefore = readIndexAt('beta');
    const betaMtimeBefore = statSync(indexPathAt('beta')).mtimeMs;

    writeDoc('alpha/a.md', 'A renamed', 'note');
    await waitForIndexAt('alpha', (md) => md.includes('[A renamed]') && !md.includes('[A one]'));

    expect(readIndexAt('beta')).toBe(betaBefore);
    expect(statSync(indexPathAt('beta')).mtimeMs).toBe(betaMtimeBefore);
  });

  test('editing only body prose rebuilds no index', async () => {
    await bootServer();
    writeDoc('notes/n.md', 'A note', 'note', 'A description.');
    await waitForIndexAt('notes', (md) => md.includes('[A note]'));

    const before = readIndexAt('notes');
    const mtimeBefore = statSync(indexPathAt('notes')).mtimeMs;

    writeFileSync(
      join(contentDir, 'notes', 'n.md'),
      '---\ntitle: A note\ntype: note\ndescription: A description.\n---\n\n# A note\n\nRewritten prose.\n',
      'utf-8',
    );

    await new Promise((r) => setTimeout(r, 3_000));

    expect(readIndexAt('notes')).toBe(before);
    expect(statSync(indexPathAt('notes')).mtimeMs).toBe(mtimeBefore);
  });

  test('an agent write through the API that changes a field rebuilds its folder index', async () => {
    await bootServer();
    writeDoc('notes/n.md', 'Before', 'note', 'A description.');
    await waitForIndexAt('notes', (md) => md.includes('[Before]'));
    const api = await apiBaseUrl();

    await agentWriteMd(
      api,
      'notes/n',
      '---\ntitle: After\ntype: note\ndescription: A description.\n---\n\n# After\n',
    );

    await waitForIndexAt('notes', (md) => md.includes('[After]') && !md.includes('[Before]'));
  });

  test('an agent write through the API that changes only body prose rebuilds no index', async () => {
    await bootServer();
    writeDoc('notes/n.md', 'A note', 'note', 'A description.');
    await waitForIndexAt('notes', (md) => md.includes('[A note]'));
    const api = await apiBaseUrl();

    const before = readIndexAt('notes');
    const mtimeBefore = statSync(indexPathAt('notes')).mtimeMs;

    await agentWriteMd(
      api,
      'notes/n',
      '---\ntitle: A note\ntype: note\ndescription: A description.\n---\n\n# A note\n\nRewritten prose.\n',
    );

    await new Promise((r) => setTimeout(r, 3_000));

    expect(readIndexAt('notes')).toBe(before);
    expect(statSync(indexPathAt('notes')).mtimeMs).toBe(mtimeBefore);
  });

  test('deleting a populated subdirectory drops it from its parent index', async () => {
    await bootServer();
    writeDoc('area/top.md', 'Top', 'note');
    writeDoc('area/sub/deep.md', 'Deep', 'note');
    await waitForIndexAt('area', (md) => md.includes('* [sub](./sub/index.md)'));
    expect(readIndexAt('area')).toContain('./top.md');

    rmSync(join(contentDir, 'area', 'sub'), { recursive: true, force: true });

    await waitForIndexAt('area', (md) => !md.includes('./sub/index.md'));
    expect(readIndexAt('area')).toContain('./top.md');
  });

  test('deleting a directory last admitted document preserves its orphan index', async () => {
    writeDoc('area/only.md', 'Only', 'note');
    await bootServer();
    await server?.generatedIndexSweepReady;
    await waitForIndexAt('area', (md) => md.includes('./only.md'));
    await waitForIndex((md) => md.includes('* [area](./area/index.md)'));

    const orphanBytes = readIndexAt('area');
    const orphanMtime = statSync(indexPathAt('area')).mtimeMs;

    unlinkSync(join(contentDir, 'area', 'only.md'));

    await waitForIndex((md) => !md.includes('./area/index.md'));
    expect(readIndexAt('area')).toBe(orphanBytes);
    expect(statSync(indexPathAt('area')).mtimeMs).toBe(orphanMtime);
  });

  test('a burst across two folders settles both in one convergence', async () => {
    await bootServer();
    writeDoc('one/a.md', 'A', 'note');
    writeDoc('one/b.md', 'B', 'note');
    writeDoc('two/c.md', 'C', 'note');

    await waitForIndexAt('one', (md) => md.includes('[A]') && md.includes('[B]'));
    await waitForIndexAt('two', (md) => md.includes('[C]'));
    await waitForIndex((md) => md.includes('./one/index.md') && md.includes('./two/index.md'));
  });

  test('enabling generation sweeps nested folders, not only the root', async () => {
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      stringifyYaml({ contentRules: { okf: { enabled: true, generate: { index: false } } } }),
      'utf-8',
    );
    writeDoc('deep/leaf.md', 'Leaf', 'note');
    await bootServer();
    expect(existsSync(indexPath())).toBe(false);
    expect(existsSync(indexPathAt('deep'))).toBe(false);

    const baseUrl = await apiBaseUrl();
    const enabled = await fetch(`${baseUrl}/api/generated-index/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      enabled: true,
      active: true,
      applied: true,
    });

    await waitForIndexAt('deep', (md) => md.includes('[Leaf]'));
    await waitForIndex((md) => md.includes('./deep/index.md'));
  });

  test("a document in a pre-existing folder reaches the folder's parent index", async () => {
    mkdirSync(join(contentDir, 'concepts'), { recursive: true });
    writeDoc('anchor.md', 'Anchor', 'note');
    await bootServer();

    await waitForIndex((md) => md.includes('[Anchor]'));
    expect(readIndex()).not.toContain('./concepts/index.md');

    writeDoc('concepts/first.md', 'First', 'concept');

    await waitForIndexAt('concepts', (md) => md.includes('* [First](./first.md)'));
    await waitForIndex((md) => md.includes('* [concepts](./concepts/index.md)'));

    const childMtime = statSync(indexPathAt('concepts')).mtimeMs;
    const rootMtime = statSync(indexPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(statSync(indexPathAt('concepts')).mtimeMs).toBe(childMtime);
    expect(statSync(indexPath()).mtimeMs).toBe(rootMtime);
  });

  test('a cold boot converges a multi-depth tree in a single pass', async () => {
    writeDoc('root-note.md', 'Root note', 'note');
    writeDoc('topic/overview.md', 'Overview', 'concept');
    writeDoc('topic/deep/detail.md', 'Detail', 'concept');
    writeDoc('container/leaf/item.md', 'Item', 'note');

    const decisionOrder: string[] = [];
    const activeServer = await startServerWithIndexHooks({
      beforeDecision: ({ directory, fullSweep }) => {
        if (fullSweep) decisionOrder.push(directory);
      },
    });
    await activeServer.ready;
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'completed',
      indexCount: 5,
    });
    expect(decisionOrder).toEqual(['container/leaf', 'topic/deep', 'container', 'topic', '']);

    expect(existsSync(indexPath())).toBe(true);
    for (const dir of ['topic', 'topic/deep', 'container', 'container/leaf']) {
      expect(existsSync(indexPathAt(dir))).toBe(true);
    }

    const root = readIndex();
    expect(root).toContain('* [Root note](./root-note.md)');
    expect(root).toContain('* [container](./container/index.md)');
    expect(root).toContain('* [topic](./topic/index.md)');
    expect(root).not.toContain('./topic/overview.md');

    const topic = readIndexAt('topic');
    expect(topic).toContain('* [Overview](./overview.md)');
    expect(topic).toContain('* [deep](./deep/index.md)');

    const deep = readIndexAt('topic/deep');
    expect(deep).toContain('* [Detail](./detail.md)');
    expect(deep).not.toContain('## Subdirectories');

    const container = readIndexAt('container');
    expect(container).toContain('* [leaf](./leaf/index.md)');
    expect(container).not.toContain('## note');
    expect(readIndexAt('container/leaf')).toContain('* [Item](./item.md)');
  });

  test('a second boot over a converged tree rewrites no index', async () => {
    writeDoc('root-note.md', 'Root note', 'note');
    writeDoc('topic/overview.md', 'Overview', 'concept');
    writeDoc('topic/deep/detail.md', 'Detail', 'concept');
    writeDoc('container/leaf/item.md', 'Item', 'note');
    await bootServer();

    const indexed = ['', 'topic', 'topic/deep', 'container', 'container/leaf'];
    const snapshot = indexed.map((dir) => {
      const path = dir === '' ? indexPath() : indexPathAt(dir);
      return { path, bytes: readFileSync(path, 'utf-8'), mtime: statSync(path).mtimeMs };
    });

    await server?.destroy();
    await bootServer();

    for (const { path, bytes, mtime } of snapshot) {
      expect(readFileSync(path, 'utf-8')).toBe(bytes);
      expect(statSync(path).mtimeMs).toBe(mtime);
    }
  });

  const UNION_FIXTURE_ANCESTOR_INDEX = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    '# Index',
    '',
    '## Guide',
    '',
    '* [Alpha](./alpha.md)',
    '',
    '## Index',
    '',
    '* [Home](./README.md)',
    '',
  ].join('\n');

  const UNION_FIXTURE_OLD_SHAPE_BRANCH_INDEX = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    '# Index',
    '',
    '## Guide',
    '',
    '* [Alpha](./alpha.md)',
    '* [Beta](./beta.md)',
    '',
    '## Index',
    '',
    '* [Home](./README.md)',
    '',
  ].join('\n');

  const UNION_FIXTURE_NEW_SHAPE_BRANCH_INDEX = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    '# Index',
    '',
    '* [Home](./README.md)',
    '',
    '## Guide',
    '',
    '* [Alpha](./alpha.md)',
    '',
  ].join('\n');

  const UNION_FIXTURE_EXPECTED_SWEPT_INDEX = [
    '---',
    'okf_version: "0.2"',
    '---',
    '',
    '# Index',
    '',
    '* [Home](./README.md)',
    '',
    '## Guide',
    '',
    '* [Alpha](./alpha.md)',
    '* [Beta](./beta.md)',
    '',
  ].join('\n');

  const DEFAULT_PROFILE_LINT_CONFIG: LinterConfig = {
    ...DEFAULT_LINTER_CONFIG,
    enabled: true,
    plugins: {
      ...DEFAULT_LINTER_CONFIG.plugins,
      markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
      okf: { enabled: true },
    },
  };

  async function lintIndexCodes(markdown: string): Promise<string[]> {
    const findings = await lintDocument(markdown, DEFAULT_PROFILE_LINT_CONFIG, 'index.md');
    return findings.map((finding) => finding.code);
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  function fixtureGit(...args: string[]): string {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=Open Knowledge Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.attributesFile=',
        '-c',
        'core.hooksPath=',
        ...args,
      ],
      { cwd: projectDir, encoding: 'utf-8' },
    );
    const ended = result.signal ? `killed by ${result.signal}` : `exited ${result.status}`;
    expect(
      result.status,
      `git ${args.join(' ')} ${ended}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
    ).toBe(0);
    return result.stdout ?? '';
  }

  async function commitOldShapeAncestorUnderUnionMerge(): Promise<string> {
    fixtureGit('init', '-q', '--template=');

    const installed = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames: ['index'],
      enabled: true,
    });
    expect(installed.ok).toBe(true);
    expect(installed.status).toEqual({ state: 'ready', ownership: 'open-knowledge' });

    writeDoc('README.md', 'Home', 'Index');
    writeDoc('alpha.md', 'Alpha', 'Guide');
    writeFileSync(indexPath(), UNION_FIXTURE_ANCESTOR_INDEX, 'utf-8');
    fixtureGit('add', '-A');
    fixtureGit('commit', '-qm', 'old-shape ancestor index');

    return fixtureGit('branch', '--show-current').trim();
  }

  test('a union merge across the index layout change leaves a duplicated entry that one boot sweep repairs to canonical bytes', async () => {
    const baseBranch = await commitOldShapeAncestorUnderUnionMerge();

    fixtureGit('checkout', '-q', '-b', 'edits-the-old-shape-index');
    writeDoc('beta.md', 'Beta', 'Guide');
    writeFileSync(indexPath(), UNION_FIXTURE_OLD_SHAPE_BRANCH_INDEX, 'utf-8');
    fixtureGit('add', '-A');
    fixtureGit('commit', '-qm', 'add beta to the old-shape guide section');

    fixtureGit('checkout', '-q', baseBranch);
    writeFileSync(indexPath(), UNION_FIXTURE_NEW_SHAPE_BRANCH_INDEX, 'utf-8');
    fixtureGit('add', '-A');
    fixtureGit('commit', '-qm', 'regenerate the index in the new shape');

    fixtureGit('merge', '--no-edit', '-q', 'edits-the-old-shape-index');

    const merged = readIndex();
    expect(await lintIndexCodes(merged)).toEqual(['MD024']);
    expect(countOccurrences(merged, '* [Home](./README.md)')).toBe(2);
    expect(merged).toContain('## Index');
    expect(UNION_FIXTURE_EXPECTED_SWEPT_INDEX).not.toBe(UNION_FIXTURE_OLD_SHAPE_BRANCH_INDEX);
    expect(UNION_FIXTURE_EXPECTED_SWEPT_INDEX).not.toBe(UNION_FIXTURE_NEW_SHAPE_BRANCH_INDEX);

    const fullSweepDirectories: string[] = [];
    const activeServer = await startServerWithIndexHooks({
      beforeDecision: ({ directory, fullSweep }) => {
        if (fullSweep) fullSweepDirectories.push(directory);
      },
    });
    await activeServer.ready;
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'completed',
      indexCount: 1,
    });
    expect(fullSweepDirectories).toEqual(['']);

    const swept = readIndex();
    expect(swept).toBe(UNION_FIXTURE_EXPECTED_SWEPT_INDEX);
    expect(await lintIndexCodes(swept)).toEqual([]);
  });

  test('the layout upgrade alone merges to canonical bytes that the boot sweep leaves unwritten', async () => {
    const logCapture = captureAllLoggers();
    const baseBranch = await commitOldShapeAncestorUnderUnionMerge();

    fixtureGit('checkout', '-q', '-b', 'leaves-the-index-alone');
    writeFileSync(
      join(contentDir, 'alpha.md'),
      '---\ntitle: Alpha\ntype: Guide\n---\n\n# Alpha\n\nRevised prose.\n',
      'utf-8',
    );
    fixtureGit('add', '-A');
    fixtureGit('commit', '-qm', 'revise alpha without touching the index');

    fixtureGit('checkout', '-q', baseBranch);
    writeDoc('beta.md', 'Beta', 'Guide');
    writeFileSync(indexPath(), UNION_FIXTURE_EXPECTED_SWEPT_INDEX, 'utf-8');
    fixtureGit('add', '-A');
    fixtureGit('commit', '-qm', 'add beta and regenerate the index in the new shape');

    fixtureGit('merge', '--no-edit', '-q', 'leaves-the-index-alone');

    const merged = readIndex();
    expect(merged).toBe(UNION_FIXTURE_EXPECTED_SWEPT_INDEX);

    const bytesBeforeBoot = merged;
    const mtimeBeforeBoot = statSync(indexPath()).mtimeMs;

    const activeServer = await startServerWithIndexHooks({});
    await activeServer.ready;
    await expect(activeServer.generatedIndexSweepReady).resolves.toEqual({
      status: 'completed',
      indexCount: 1,
    });

    expect(
      logCapture
        .getCalls()
        .filter((entry) => entry.payload.event === 'generated-index-regeneration')
        .map((entry) => entry.payload),
    ).toEqual([{ event: 'generated-index-regeneration', outcome: 'unchanged', directory: '' }]);
    expect(readIndex()).toBe(bytesBeforeBoot);
    expect(statSync(indexPath()).mtimeMs).toBe(mtimeBeforeBoot);
  });
});

interface ReconcileRig {
  tmpDir: string;
  shadow: ShadowHandle;
  cleanup: () => void;
}

async function setupReconcileRig(prefix: string): Promise<ReconcileRig> {
  const tmpDir = await realpath(mkdtempSync(join(tmpdir(), prefix)));
  const git = simpleGit({ baseDir: tmpDir });
  await git.init();
  await git.raw('symbolic-ref', 'HEAD', 'refs/heads/main');
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  const shadow = await initShadowRepo(tmpDir);
  return {
    tmpDir,
    shadow,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function createReconcileServer(rig: ReconcileRig): ServerInstance {
  return createServer({
    contentDir: rig.tmpDir,
    projectDir: rig.tmpDir,
    quiet: true,
    debounce: 100,
    maxDebounce: 500,
    gitEnabled: false,
    shadowRepo: rig.shadow,
  });
}

async function expectAbsentDuring(
  read: () => Promise<string[]>,
  absent: string,
  durationMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const names = await read();
    expect(names).not.toContain(absent);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('createServer() — disk-event reconcile with an absent reconciled base', () => {
  let rig: ReconcileRig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('an external disk update on a loaded doc with an absent base adopts disk content instead of concatenating it', async () => {
    rig = await setupReconcileRig('ok-reconcile-absent-base-');
    const docName = 'absent-base-target';
    const initial = '# Absent base target\n\nParagraph that only the editor doc holds.\n';
    const theirs = '# Absent base target\n\nDisk-authoritative replacement paragraph.\n';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');

    const server = createReconcileServer(rig);
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(docName);
      expect(server.durabilityState.getReconciledBase(docName)).toBeUndefined();

      writeFileSync(docPath, theirs, 'utf-8');

      await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(theirs), {
        timeout: 8_000,
        interval: 25,
      });
      expect(serverDoc.getText('source').toString()).not.toContain(
        'Paragraph that only the editor doc holds.',
      );
      expect(server.durabilityState.getReconciledBase(docName)).toBe(theirs);
      expect(readFileSync(docPath, 'utf-8')).toBe(theirs);

      await vi.waitFor(
        async () => {
          const rescues = await listRescueCheckpoints(rig.shadow, 'main');
          expect(rescues.map((r) => r.docName)).toContain(docName);
        },
        { timeout: 10_000, interval: 50 },
      );

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 30_000);

  test('delete-path teardown with an absent base still rescues a non-empty doc and spares an empty doc', async () => {
    rig = await setupReconcileRig('ok-reconcile-rescue-guard-');
    const fullDoc = 'rescue-guard-full';
    const emptyDoc = 'rescue-guard-empty';
    const fullContent = '# Rescue guard full\n\nLive body that exists only in the editor doc.\n';
    writeFileSync(join(rig.tmpDir, `${fullDoc}.md`), fullContent, 'utf-8');
    writeFileSync(join(rig.tmpDir, `${emptyDoc}.md`), '', 'utf-8');

    const server = createReconcileServer(rig);
    try {
      await server.ready;
      await server.hocuspocus.openDirectConnection(fullDoc);
      await server.hocuspocus.openDirectConnection(emptyDoc);
      await vi.waitFor(
        () => {
          expect(server.durabilityState.getReconciledBase(fullDoc)).toBe(fullContent);
          expect(server.durabilityState.getReconciledBase(emptyDoc)).toBe('');
        },
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(fullDoc);
      server.durabilityState.deleteReconciledBase(emptyDoc);

      unlinkSync(join(rig.tmpDir, `${fullDoc}.md`));
      unlinkSync(join(rig.tmpDir, `${emptyDoc}.md`));

      await vi.waitFor(
        async () => {
          const rescues = await listRescueCheckpoints(rig.shadow, 'main');
          expect(rescues.map((r) => r.docName)).toContain(fullDoc);
        },
        { timeout: 10_000, interval: 50 },
      );

      await expectAbsentDuring(
        async () => (await listRescueCheckpoints(rig.shadow, 'main')).map((r) => r.docName),
        emptyDoc,
      );
      const rescues = await listRescueCheckpoints(rig.shadow, 'main');
      expect(rescues).toHaveLength(1);
      const rescue = rescues[0];
      expect(rescue?.docName).toBe(fullDoc);
      expect(rescue?.label).toContain('External change recovered');
      expect(rescue?.incomingDiskSha).toBe('');
      const deleteRescueBody = (
        await shadowGit(rig.shadow).raw('log', '-1', '--format=%B', rescue?.sha ?? '')
      ).trim();
      expect(parseCheckpoint(deleteRescueBody)?.kind).toBe('external-change-rescue');
    } finally {
      await server.destroy();
    }
  }, 30_000);

  test('rename-path teardown rescues a dirty doc under the same checkpoint kind as the other teardown sites', async () => {
    rig = await setupReconcileRig('ok-reconcile-rename-rescue-');
    const docName = 'rename-rescue-source';
    const newDocName = 'rename-rescue-destination';
    const diskContent = '# Rename rescue source\n\nOn-disk body.\n';
    writeFileSync(join(rig.tmpDir, `${docName}.md`), diskContent, 'utf-8');

    const server = createReconcileServer(rig);
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(diskContent),
        { timeout: 5_000, interval: 25 },
      );

      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed paragraph only in the editor doc.\n');
      });
      await vi.waitFor(
        () =>
          expect(server.hocuspocus.documents.get(docName)?.getText('source').toString()).toContain(
            'Unflushed paragraph only in the editor doc.',
          ),
        { timeout: 5_000, interval: 25 },
      );

      renameSync(join(rig.tmpDir, `${docName}.md`), join(rig.tmpDir, `${newDocName}.md`));

      let rescueSha = '';
      await vi.waitFor(
        async () => {
          const rescues = await listRescueCheckpoints(rig.shadow, 'main');
          const rescue = rescues.find((r) => r.docName === docName);
          expect(rescue).toBeDefined();
          rescueSha = rescue?.sha ?? '';
        },
        { timeout: 10_000, interval: 50 },
      );
      const renameRescueBody = (
        await shadowGit(rig.shadow).raw('log', '-1', '--format=%B', rescueSha)
      ).trim();
      expect(parseCheckpoint(renameRescueBody)?.kind).toBe('external-change-rescue');
      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 30_000);

  test('a branch-switch round trip keeps an absent-base doc on disk content instead of resurrecting parked WIP', async () => {
    const projectDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-reconcile-park-')));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    const docName = 'park-roundtrip-target';
    const mainContent = '# Park roundtrip target\n\nMain branch body.\n';
    const featureContent = '# Park roundtrip target\n\nFeature branch body.\n';
    writeFileSync(join(projectDir, `${docName}.md`), mainContent, 'utf-8');
    await git.add('.');
    await git.commit('main content');
    await git.checkoutLocalBranch('feature');
    writeFileSync(join(projectDir, `${docName}.md`), featureContent, 'utf-8');
    await git.add(['-A']);
    await git.commit('feature content');
    await git.checkout('main');

    const shadow = await initShadowRepo(projectDir);
    rig = {
      tmpDir: projectDir,
      shadow,
      cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
    };
    const server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      debounce: 100,
      maxDebounce: 500,
      gitEnabled: false,
      shadowRepo: shadow,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(mainContent),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(docName);

      await git.checkout('feature');
      await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(featureContent), {
        timeout: 15_000,
        interval: 25,
      });
      expect(serverDoc.getMap('lifecycle').get('status')).toBeUndefined();

      await git.checkout('main');
      await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(mainContent), {
        timeout: 15_000,
        interval: 25,
      });
      expect(serverDoc.getText('source').toString()).not.toContain('Feature branch body.');
      expect(server.durabilityState.getReconciledBase(docName)).toBe(mainContent);
      expect(serverDoc.getMap('lifecycle').get('status')).toBeUndefined();

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 60_000);

  test('a branch-switch reset rescues unflushed WIP on an absent-base doc before overwriting with disk content', async () => {
    const projectDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-reconcile-bs-rescue-')));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    const docName = 'branch-switch-rescue-target';
    const diskContent = '# Branch switch rescue target\n\nSame body on both branches.\n';
    writeFileSync(join(projectDir, `${docName}.md`), diskContent, 'utf-8');
    await git.add('.');
    await git.commit('main content');
    await git.checkoutLocalBranch('feature');
    await git.checkout('main');

    const shadow = await initShadowRepo(projectDir);
    rig = {
      tmpDir: projectDir,
      shadow,
      cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
    };
    const server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      debounce: 60_000,
      maxDebounce: 60_000,
      gitEnabled: false,
      shadowRepo: shadow,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(diskContent),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(docName);

      await conn.transact((doc) => {
        const source = doc.getText('source');
        source.insert(source.length, '\nUnflushed WIP paragraph only in the editor.\n');
      });
      await vi.waitFor(
        () =>
          expect(serverDoc.getText('source').toString()).toContain(
            'Unflushed WIP paragraph only in the editor.',
          ),
        { timeout: 5_000, interval: 25 },
      );
      const wipText = serverDoc.getText('source').toString();
      expect(wipText).not.toBe(diskContent);

      const warnSpy = vi.spyOn(getLogger('server'), 'warn');
      try {
        await git.checkout('feature');

        await vi.waitFor(
          () =>
            expect(serverDoc.getText('source').toString()).not.toContain('Unflushed WIP paragraph'),
          { timeout: 15_000, interval: 25 },
        );
        expect(serverDoc.getText('source').toString()).toBe(diskContent);
        expect(server.durabilityState.getReconciledBase(docName)).toBe(diskContent);
        expect(serverDoc.getMap('lifecycle').get('status')).toBeUndefined();

        await vi.waitFor(
          async () => {
            const rescues = await listRescueCheckpoints(rig.shadow, 'feature');
            const rescue = rescues.find((r) => r.docName === docName);
            expect(rescue).toBeDefined();
            expect(rescue?.incomingDiskSha).toBe('');
            expect(rescue?.size).toBe(wipText.length);
          },
          { timeout: 10_000, interval: 50 },
        );

        const branchSwitchRescue = (await listRescueCheckpoints(rig.shadow, 'feature')).find(
          (r) => r.docName === docName,
        );
        const branchSwitchBody = (
          await shadowGit(rig.shadow).raw('log', '-1', '--format=%B', branchSwitchRescue?.sha ?? '')
        ).trim();
        expect(parseCheckpoint(branchSwitchBody)?.kind).toBe('external-change-rescue');

        const warnTexts = warnSpy.mock.calls.map((call) => String(call[1] ?? ''));
        expect(warnTexts.some((s) => s.includes('skipped parking'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 60_000);

  test('a first-visit branch switch mints no rescue for a settled doc whose content already matches the destination disk', async () => {
    const projectDir = await realpath(mkdtempSync(join(tmpdir(), 'ok-reconcile-firstvisit-')));
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    const docName = 'first-visit-settled';
    const settledContent = '# First visit settled\n\nSame body on both branches.\n';
    writeFileSync(join(projectDir, `${docName}.md`), settledContent, 'utf-8');
    await git.add('.');
    await git.commit('main content');

    const shadow = await initShadowRepo(projectDir);
    rig = {
      tmpDir: projectDir,
      shadow,
      cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
    };
    const server = createServer({
      contentDir: projectDir,
      projectDir,
      quiet: true,
      debounce: 60_000,
      maxDebounce: 60_000,
      gitEnabled: false,
      shadowRepo: shadow,
    });
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(settledContent),
        { timeout: 5_000, interval: 25 },
      );

      await git.checkoutLocalBranch('feature');

      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(settledContent),
        { timeout: 15_000, interval: 25 },
      );
      expect(serverDoc.getText('source').toString()).toBe(settledContent);
      expect(serverDoc.getMap('lifecycle').get('status')).toBeUndefined();

      await expectAbsentDuring(
        async () => (await listRescueCheckpoints(rig.shadow, 'feature')).map((r) => r.docName),
        docName,
      );

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 60_000);

  test('a blockless acknowledged base refuses the merge and adopts disk content with a rescue', async () => {
    rig = await setupReconcileRig('ok-reconcile-refused-no-base-');
    const docName = 'refused-no-base-target';
    const initial = '# Refused no-base target\n\nParagraph that only the editor doc holds.\n';
    const theirs = '# Refused no-base target\n\nDisk-authoritative replacement paragraph.\n';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');

    const server = createReconcileServer(rig);
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.setReconciledBase(docName, '');
      expect(server.durabilityState.getReconciledBase(docName)).toBe('');

      const ingestsBefore = getMetrics().diskAuthoritativeIngestCount;
      writeFileSync(docPath, theirs, 'utf-8');

      await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(theirs), {
        timeout: 8_000,
        interval: 25,
      });
      expect(serverDoc.getText('source').toString()).not.toContain(
        'Paragraph that only the editor doc holds.',
      );
      expect(server.durabilityState.getReconciledBase(docName)).toBe(theirs);
      expect(readFileSync(docPath, 'utf-8')).toBe(theirs);
      expect(serverDoc.getMap('lifecycle').get('status')).toBeUndefined();
      expect(getMetrics().diskAuthoritativeIngestCount).toBe(ingestsBefore + 1);

      await vi.waitFor(
        async () => {
          const rescues = await listRescueCheckpoints(rig.shadow, 'main');
          const rescue = rescues.find((r) => r.docName === docName);
          expect(rescue).toBeDefined();
          expect(rescue?.incomingDiskSha).toBe(contentHash(theirs).slice(0, 6));
        },
        { timeout: 10_000, interval: 50 },
      );

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 30_000);

  test('the disk-authoritative ingest durably buffers live-only content before it adopts disk bytes', async () => {
    rig = await setupReconcileRig('ok-reconcile-ingest-rescue-order-');
    const docName = 'ingest-rescue-order-target';
    const initial =
      '# Ingest rescue order target\n\nLive paragraph that exists only in the editor.\n';
    const theirs = '# Ingest rescue order target\n\nDisk-authoritative replacement paragraph.\n';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');

    const server = createReconcileServer(rig);
    const infoSpy = vi.spyOn(getLogger('server'), 'info');
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(docName);

      const rescuePath = join(rig.shadow.gitDir, 'rescue', `${docName}.md`);
      expect(existsSync(rescuePath)).toBe(false);
      const unrescuedBefore = getMetrics().diskAuthoritativeIngestUnrescuedCount;

      writeFileSync(docPath, theirs, 'utf-8');

      await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(theirs), {
        timeout: 8_000,
        interval: 25,
      });

      expect(existsSync(rescuePath)).toBe(true);
      expect(readFileSync(rescuePath, 'utf-8')).toBe(initial);
      expect(getMetrics().diskAuthoritativeIngestUnrescuedCount).toBe(unrescuedBefore);

      const ingestLog = infoSpy.mock.calls.find(
        (call) => (call[0] as { reason?: string } | undefined)?.reason === 'no-base',
      );
      expect(ingestLog?.[0]).toMatchObject({ docName, result: 'clean', rescue: 'rescued' });

      conn.disconnect();
    } finally {
      infoSpy.mockRestore();
      await server.destroy();
    }
  }, 30_000);

  test('an ingest whose rescue writes all fail is not reported as a clean ingest', async () => {
    rig = await setupReconcileRig('ok-reconcile-rescue-write-failure-');
    const docName = 'rescue-write-failure-target';
    const initial =
      '# Rescue write failure target\n\nLive paragraph that exists only in the editor.\n';
    const theirs = '# Rescue write failure target\n\nDisk-authoritative replacement paragraph.\n';
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, initial, 'utf-8');

    const server = createReconcileServer(rig);
    const chmodEntries: Array<{ path: string; mode: number }> = [];
    const warnSpy = vi.spyOn(getLogger('server'), 'warn');
    const errorSpy = vi.spyOn(getLogger('server'), 'error');
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(
        () => expect(server.durabilityState.getReconciledBase(docName)).toBe(initial),
        { timeout: 5_000, interval: 25 },
      );

      server.durabilityState.deleteReconciledBase(docName);

      const shadowGitDir = rig.shadow.gitDir;
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const entryPath = join(dir, entry.name);
          chmodEntries.push({ path: entryPath, mode: statSync(entryPath).mode & 0o777 });
          if (entry.isDirectory()) walk(entryPath);
        }
      };
      chmodEntries.push({ path: shadowGitDir, mode: statSync(shadowGitDir).mode & 0o777 });
      walk(shadowGitDir);
      for (const entry of chmodEntries) chmodSync(entry.path, 0o500);

      const failuresBefore = getMetrics().rescueCheckpointWriteFailures;
      const bufferFailuresBefore = getMetrics().rescueBufferWriteFailures;
      const unrescuedBefore = getMetrics().diskAuthoritativeIngestUnrescuedCount;
      const ingestsBefore = getMetrics().diskAuthoritativeIngestCount;
      try {
        writeFileSync(docPath, theirs, 'utf-8');

        await vi.waitFor(() => expect(serverDoc.getText('source').toString()).toBe(theirs), {
          timeout: 8_000,
          interval: 25,
        });
        expect(server.durabilityState.getReconciledBase(docName)).toBe(theirs);
        await vi.waitFor(
          () => expect(getMetrics().rescueCheckpointWriteFailures).toBeGreaterThan(failuresBefore),
          { timeout: 10_000, interval: 25 },
        );
        expect(getMetrics().diskAuthoritativeIngestCount).toBe(ingestsBefore + 1);
        expect(getMetrics().rescueBufferWriteFailures).toBeGreaterThan(bufferFailuresBefore);
        expect(getMetrics().diskAuthoritativeIngestUnrescuedCount).toBe(unrescuedBefore + 1);
      } finally {
        for (const entry of chmodEntries) {
          if (!existsSync(entry.path)) continue;
          chmodSync(entry.path, entry.mode);
        }
      }

      const rescues = await listRescueCheckpoints(rig.shadow, 'main');
      expect(rescues.filter((r) => r.docName === docName)).toHaveLength(0);
      expect(existsSync(join(rig.shadow.gitDir, 'rescue', `${docName}.md`))).toBe(false);

      const ingestLog = warnSpy.mock.calls.find(
        (call) => (call[0] as { reason?: string } | undefined)?.reason === 'no-base',
      );
      expect(ingestLog?.[0]).toMatchObject({ docName, result: 'clean-unrescued', rescue: 'lost' });

      const rescueFailure = errorSpy.mock.calls.find((call) =>
        String(call[1]).startsWith('[rescue] failed to write rescue buffer'),
      );
      expect(rescueFailure?.[0]).toMatchObject({ docName, context: 'disk-authoritative-ingest' });

      conn.disconnect();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      await server.destroy();
    }
  }, 45_000);
});

describe('createServer() — disk-event reconcile insert-group dedup reporting', () => {
  let rig: ReconcileRig;

  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    rig?.cleanup();
  });

  test('a conflicting reconcile that also skipped insert dedup past the LCS cap still counts the skip', async () => {
    rig = await setupReconcileRig('ok-reconcile-conflict-dedup-');
    const docName = 'conflict-dedup-target';
    const perSide = Math.ceil(Math.sqrt(MAX_LCS_CELLS)) + 10;
    const shared = Array.from({ length: 10 }, (_, i) => `Shared ${i}.`);
    const base = 'Anchor.\n';
    const ourBlocks = [
      'Anchor edited by us.',
      ...shared,
      ...Array.from({ length: perSide }, (_, i) => `Ours ${i}.`),
    ];
    const theirBlocks = [
      'Anchor edited by them.',
      ...shared,
      ...Array.from({ length: perSide }, (_, i) => `Theirs ${i}.`),
    ];
    const ours = `${ourBlocks.join('\n\n')}\n`;
    const theirs = `${theirBlocks.join('\n\n')}\n`;
    const docPath = join(rig.tmpDir, `${docName}.md`);
    writeFileSync(docPath, ours, 'utf-8');

    const server = createReconcileServer(rig);
    try {
      await server.ready;
      const conn = await server.hocuspocus.openDirectConnection(docName);
      const serverDoc = server.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeDefined();
      if (!serverDoc) return;
      await vi.waitFor(() => expect(server.durabilityState.getReconciledBase(docName)).toBe(ours), {
        timeout: 20_000,
        interval: 50,
      });

      server.durabilityState.setReconciledBase(docName, base);
      const conflictsBefore = getMetrics().conflictCount;
      const dedupSkippedBefore = getMetrics().reconcileInsertDedupSkipped;

      writeFileSync(docPath, theirs, 'utf-8');

      await vi.waitFor(() => expect(getMetrics().conflictCount).toBe(conflictsBefore + 1), {
        timeout: 20_000,
        interval: 50,
      });
      const merged = serverDoc.getText('source').toString();
      expect(merged).toContain('Ours 0.');
      expect(merged).toContain(`Theirs ${perSide - 1}.`);
      expect(getMetrics().reconcileInsertDedupSkipped).toBe(dedupSkippedBefore + 1);

      conn.disconnect();
    } finally {
      await server.destroy();
    }
  }, 90_000);
});
