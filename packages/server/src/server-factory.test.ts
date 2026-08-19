import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOCAL_DIR, REMOVED_KEYS } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import * as Y from 'yjs';
import { MAX_AGENT_SESSIONS } from './agent-sessions.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { getBootTimings, resetBootTimingsForTest, startBootTimings } from './boot-timings.ts';
import { updateGeneratedIndexGitAttributes } from './content/generated-index-git-attributes.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';
import { classifyGitError } from './error-classification.ts';
import { applyExternalChange } from './external-change.ts';
import type {
  CheckPushPermissionOptions,
  DetectGhFn,
  ProbeTokenStore,
  PushPermission,
} from './github-permissions.ts';
import { buildIngressPolicy } from './ingress-policy.ts';
import { loggerFactory, type PinoLogger } from './logger.ts';
import {
  createManagedRenameRecoveryJournal,
  managedRenameJournalPath,
  writeManagedRenameJournal,
} from './managed-rename-journal.ts';
import { ensureProjectGit } from './project-git.ts';
import { saveRemovedDocsJournal } from './removed-docs-journal.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { releaseServerLock } from './server-lock.ts';
import { initShadowRepo, shadowGit } from './shadow-repo.ts';
import { TagIndex } from './tag-index.ts';

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

// ─── CaptureLogger infrastructure ───────────────────────────────────────────
// Uses loggerFactory.configure() pattern from logger.test.ts.
// NOT monkey-patching — injects a capture logger via the factory.

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

/** All loggers created during the test share this map, keyed by logger name. */
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

// ─── Test suite ─────────────────────────────────────────────────────────────

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

    // The manager's `sessionLimit` getter reads back the cap it was constructed
    // with. A missing passthrough would leave it at the default, so this pins
    // the ServerOptions → constructor wiring the low-cap capacity tests rely on.
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
    const emit = vi.spyOn(server.cc1Broadcaster, 'emitBranchSwitched');

    await git.checkout('feature');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('feature'), {
      timeout: 10_000,
      interval: 25,
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[0] ?? 0);
    expect(server.durabilityState.isBatchInProgress()).toBe(false);
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
    const emit = vi.spyOn(server.cc1Broadcaster, 'emitBranchSwitched');

    await git.checkout('feature');
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('feature'), {
      timeout: 10_000,
      interval: 25,
    });

    expect(abort).toHaveBeenCalled();
    expect(server.durabilityState.isBatchInProgress()).toBe(false);
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
      debounce: 60_000, // Prevent natural debounce from firing — proves destroy-time flush
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    // Write to XmlFragment('default') — the Y.Doc shape the persistence layer
    // reads from in onStoreDocument. getText('source') is synced to XmlFragment
    // by browser-side observers that don't exist in server-only tests.
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('hello world')]);
      xmlFragment.insert(0, [paragraph]);
    });

    // Release the DirectConnection's hold on the document WITHOUT triggering an
    // immediate store (conn.disconnect() would store with debounce=0, bypassing
    // the destroy-time flush path we want to test). removeDirectConnection()
    // decrements the connection count so the document can unload when
    // flushAllStoresAndWait fires flushPendingStores during destroy().
    //
    // NOTE: removeDirectConnection() is an internal Hocuspocus API — any
    // `@hocuspocus/server` upgrade must re-verify this coupling along with
    // the 7 other internals.
    const doc = server.hocuspocus.documents.get('test-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const onDisk = await readFile(join(tmpDir, 'test-doc.md'), 'utf-8');
    expect(onDisk).toContain('hello world');

    // behavioral contract — shutdown log emitted with documentCount >= 1
    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBeGreaterThanOrEqual(1);

    // No warn-level shutdown log means zero phaseErrors
    const warnShutdownLogs = logCapture.getCalls('warn', 'shutdown');
    expect(warnShutdownLogs).toHaveLength(0);
  });

  test('flushes L2 git commit after L1 drain', async () => {
    // Shadow repo needs contentDir to be a subdirectory of projectDir so
    // `git add <contentRoot>` has a valid pathspec. Mirror real-world layout.
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
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('commit me')]);
      xmlFragment.insert(0, [paragraph]);
    });

    // Release DirectConnection hold
    const doc = server.hocuspocus.documents.get('test-doc-2');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    // Verify L2 git commit landed in shadow repo — check for any WIP ref
    // (the exact writer ID depends on contributor-tracker state shared across tests)
    const sg = shadowGit(shadowHandle);
    const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
    expect(wipRefs).toBeTruthy();
  });

  test('shutdown order: lock release happens AFTER L1 disk flush completes', async () => {
    // Locks in the invariant: phase 6 (`releaseServerLock`) must run
    // AFTER phase 3
    // (`flushAllStoresAndWait`). Reordering them would let a concurrent
    // acquirer boot before in-flight writes have landed, racing two servers
    // against the same disk file.
    //
    // Strategy: hook `afterUnloadDocument` (fires from inside phase 3 for each
    // unloaded doc) and capture lock-file + content-file presence at that
    // exact moment. Phase-3 → phase-6 ordering means the lock MUST still
    // exist when this hook fires, and the disk write MUST have already
    // landed.
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000, // Suppress natural flush — proves destroy-time path
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
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('order-marker')]);
      xmlFragment.insert(0, [paragraph]);
    });
    const doc = server.hocuspocus.documents.get(docName);
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    expect(existsSync(lockPath)).toBe(true);
    await server.destroy();

    // Phase-3 capture: at unload-time, the lock was still held AND the L1
    // write had already landed. If phase 6 ran before phase 3 finished, this
    // capture would see `lockExists: false`.
    expect(captures.length).toBe(1);
    expect(captures[0]?.lockExists).toBe(true);
    expect(captures[0]?.contentOnDisk).toBe(true);
    expect(captures[0]?.payload).toContain('order-marker');

    // Post-destroy: the lock file SURVIVES, marked draining, still owned by
    // this pid — the unlink is deferred to actual process exit so no other
    // server can acquire while a live predecessor is still winding down.
    // Content survived. The standard end-state.
    expect(existsSync(lockPath)).toBe(true);
    const postDestroyLock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(postDestroyLock.pid).toBe(process.pid);
    expect(postDestroyLock.draining).toBe(true);
    expect(readFileSync(contentPath, 'utf-8')).toContain('order-marker');
  });

  test('destroy() completes within destroyTimeoutMs AND rescues hung docs when onStoreDocument throws', async () => {
    // Pre-construct shadow handle so the test can assert the rescue-buffer
    // file exists on disk post-destroy.
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
      destroyTimeoutMs: 500, // fast timeout for CI — not the 10s default
      shadowRepo: shadowHandle,
    });
    await server.ready;

    // Inject a failing onStoreDocument hook AFTER server construction.
    // Must throw a generic Error (not SkipFurtherHooksError) to hit the
    // "Document stays in memory to avoid data loss" branch at
    // Hocuspocus.ts — this prevents afterUnloadDocument from
    // firing and triggers our timeout path.
    server.hocuspocus.configuration.extensions.push({
      async onStoreDocument() {
        throw new Error('simulated store failure');
      },
    });

    const conn = await server.hocuspocus.openDirectConnection('pathological-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('will not be flushed')]);
      xmlFragment.insert(0, [paragraph]);
    });

    // Release DirectConnection so closeConnections doesn't block unload
    const doc = server.hocuspocus.documents.get('pathological-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    // Behavioral contract: destroy() fires the timeout path (not the 10s
    // default) when onStoreDocument throws. Widened bounds accommodate CI
    // scheduling jitter (GHA runners under load can add 100-500ms variance).
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000);

    // destroy() emits warn-level log with timeout phase error
    const warnLogs = logCapture.getCalls('warn', 'shutdown flushed');
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].payload.phaseErrors).toContainEqual(
      expect.objectContaining({
        phase: 'flush-all-stores',
        error: expect.stringContaining('timeout'),
      }),
    );

    // rescue-buffer dump on flush timeout. The in-memory Y.Doc
    // state was preserved to <history-gitDir>/rescue/<docName>.md so the user
    // can recover via the existing /api/rescue endpoints.
    const rescuePath = join(shadowHandle.gitDir, 'rescue', 'pathological-doc.md');
    expect(existsSync(rescuePath)).toBe(true);
    expect(readFileSync(rescuePath, 'utf-8')).toContain('will not be flushed');

    // The timeout error should name the rescued doc so operators can correlate
    // the warn log's phaseErrors payload with on-disk rescue files.
    const phaseError = warnLogs[0].payload.phaseErrors as Array<{
      phase: string;
      error: string;
    }>;
    const flushErr = phaseError.find((e) => e.phase === 'flush-all-stores');
    expect(flushErr?.error).toContain('rescued [pathological-doc]');

    // Structured rescue log was emitted via the [rescue] category
    const rescueLogs = logCapture.getCalls('info', '[rescue]');
    expect(rescueLogs.length).toBeGreaterThanOrEqual(1);
    expect(rescueLogs[0].payload.docName).toBe('pathological-doc');
  });

  test('destroy() is idempotent under concurrent calls', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
      debounce: 60_000,
    });
    await server.ready;

    // Write content so there's a non-trivial shutdown to exercise
    const conn = await server.hocuspocus.openDirectConnection('test-idempotent');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('idempotent content')]);
      xmlFragment.insert(0, [paragraph]);
    });
    const doc = server.hocuspocus.documents.get('test-idempotent');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    // fire two destroys in parallel — both should resolve, neither should throw.
    // The cached-Promise guard collapses them into one teardown.
    await Promise.all([server.destroy(), server.destroy()]);

    // Key assertion: only ONE shutdown log emitted (not two), proving the
    // cached-Promise guard prevented duplicate teardown.
    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);

    // A third serial call after completion also resolves without throwing
    await server.destroy();
  });

  test('destroy() during async init — before ready resolves', async () => {
    const server = createServer({
      contentDir: tmpDir,
      projectDir: tmpDir,
      quiet: true,
    });
    // DON'T await ready — call destroy() while initAsync is still running.
    // The `await ready.catch(() => {})` at the top of destroy() handles this.
    await server.destroy();

    // Should resolve cleanly without throwing and still emit a shutdown log
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

    // Only the boot-admitted synthetic DirectConnections — no content
    // documents loaded. flushAllStoresAndWait runs over them but the
    // persistence config-doc/system-doc short-circuits make each flush a
    // no-op. The short-circuit path completes fast.
    const startedAt = Date.now();
    await server.destroy();
    const elapsed = Date.now() - startedAt;

    // Short-circuit path resolves fast. Widened from 500ms → 2_000ms to avoid
    // flake on slow disks where initAsync (shadow repo + file watcher scan)
    // dominates the destroy timeline. The behavioral contract is "no 10s
    // timeout" — 2s still proves the short-circuit fired.
    expect(elapsed).toBeLessThan(2_000);

    // Shutdown log still emitted — documentCount counts the boot-admitted
    // synthetic docs (__system__, __config__/project, __local__/project,
    // __config__/okignore, __user__/config.yml).
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

    // Open 3 independent DirectConnections to different docs
    const conn1 = await server.hocuspocus.openDirectConnection('doc-a');
    const conn2 = await server.hocuspocus.openDirectConnection('doc-b');
    const conn3 = await server.hocuspocus.openDirectConnection('doc-c');

    await conn1.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content A')]);
      frag.insert(0, [p]);
    });
    await conn2.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content B')]);
      frag.insert(0, [p]);
    });
    await conn3.transact((doc) => {
      const frag = doc.getXmlFragment('default');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('content C')]);
      frag.insert(0, [p]);
    });

    // Release all DirectConnection holds
    for (const name of ['doc-a', 'doc-b', 'doc-c']) {
      const doc = server.hocuspocus.documents.get(name);
      expect(doc).toBeDefined();
      doc?.removeDirectConnection();
    }

    await server.destroy();

    // All three files should be on disk with their distinctive content
    expect(await readFile(join(tmpDir, 'doc-a.md'), 'utf-8')).toContain('content A');
    expect(await readFile(join(tmpDir, 'doc-b.md'), 'utf-8')).toContain('content B');
    expect(await readFile(join(tmpDir, 'doc-c.md'), 'utf-8')).toContain('content C');

    // Shutdown log reports documentCount === 8 (3 content docs +
    // __system__ + 4 boot-admitted config docs: project, project-local,
    // okignore, user).
    const shutdownLogs = logCapture.getCalls('info', 'shutdown flushed');
    expect(shutdownLogs).toHaveLength(1);
    expect(shutdownLogs[0].payload.documentCount).toBe(8);
  });
});

// ─── createServer() degraded signal tests ─────────────────────
// These verify that ServerInstance.degraded correctly reports which subsystems
// failed to initialize.
//
/**
 * Tests for createServer() — degraded signal from initAsync.
 *
 * Verifies that ServerInstance.degraded correctly reports which subsystems
 * failed to initialize.
 *
 * Failure injection:
 *   - shadow-repo: forced via invalid path (file-as-dir). This subsystem's
 *     init throws on invalid paths, so preferred technique works.
 *   - file-watcher + head-watcher: hoisted, call-through module mocks throw
 *     only when the corresponding per-test flag is enabled.
 */

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
    // Force shadow-repo init to fail by making `.git/ok` a file (not a dir).
    // `resolveShadowDir` returns `<projectDir>/.git/ok` for the directory case;
    // `initShadowRepo` then tries to mkdir it and throws ENOTDIR. Both the lock
    // path (`<projectDir>/.ok/local/`) and the synchronous `resolveShadowDir`
    // call in `assertCompatibleStateManifest` succeed — the failure surfaces
    // inside `initAsync`'s try/catch, where it gets pushed onto `degraded`.
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

// ─── config-doc admission + bridge bypass ──────────────────────────
//
// Synthetic config docs are admitted Y.Text-only at boot, and the
// markdown observer bridge is bypassed for non-content docs.
// Subsystem short-circuits (persistence, agent-sessions, file-watcher,
// content-filter, etc.) are unit-tested in their respective files. This
// suite proves the boot-time admission + the bridge bypass end-to-end
// against a real Hocuspocus instance.

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
    // Admission failures would surface as `degraded` entries — none expected
    // for a clean init.
    expect(srv.degraded.filter((s) => s.startsWith('config-doc:'))).toEqual([]);

    await srv.destroy();
  });

  test('Y.Text mutation on a config doc does NOT engage the markdown bridge (D41)', async () => {
    const contentDir = mkdtempSync(resolve(testProjectDir, 'content-'));
    const srv = createServer({
      contentDir,
      projectDir: testProjectDir,
      quiet: true,
    });

    await srv.ready;

    const configDoc = srv.hocuspocus.documents.get('__config__/project');
    expect(configDoc).toBeDefined();
    if (!configDoc) return;

    // Bridge contract: Observer B (Y.Text → XmlFragment) would populate the
    // 'default' XmlFragment from a Y.Text mutation. With the bypass in
    // server-observer-extension.ts, the bridge never attaches for config
    // docs, so the XmlFragment stays empty regardless of Y.Text content.
    const ytext = configDoc.getText('source');
    const xmlFragment = configDoc.getXmlFragment('default');
    expect(xmlFragment.length).toBe(0);

    configDoc.transact(() => {
      ytext.insert(0, 'theme: dark\n');
    });

    // Allow any debounced observer scheduling to settle (bridge would fire
    // synchronously inside the transact, but await one microtask round to
    // be safe).
    await new Promise((r) => setTimeout(r, 50));

    expect(ytext.toString()).toBe('theme: dark\n');
    // Bridge bypass verified: the XmlFragment was never populated.
    expect(xmlFragment.length).toBe(0);

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

    // openDirectConnection is the in-process equivalent of a client
    // attaching over the collab WS — it goes through the same auth
    // extension. No additional gating needed for config docs.
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

// ─── config file watcher ───────────────────────────────────────────
//
// chokidar single-file watch with awaitWriteFinish for
// atomic-rename detection, server-origin Y.Text update on external change,
// LKG-equality short-circuit prevents persistence-hook self-write feedback.

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

    // Y.Text starts empty (no prior config.yml on disk).
    expect(ytext.toString()).toBe('');

    // Simulate a CLI / IDE / hand-edit creating the project config.
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
    // Pre-seed a valid project config so the watcher's first read populates
    // LKG with valid content; then write broken YAML and assert Y.Text stays.
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

    // Initial seed put validContent into Y.Text.
    expect(ytext.toString()).toBe(validContent);

    // Externally write broken YAML. Watcher fires, validation rejects;
    // Y.Text MUST stay at LKG.
    writeFileSync(configPath, 'content: [unclosed\n', 'utf-8');
    // Give the watcher a generous window to fire + reject.
    const warningLogged = await waitFor(
      () => logs.getCalls('warn', 'project config invalid').length > 0,
    );

    expect(warningLogged).toBe(true);
    expect(ytext.toString()).toBe(validContent);
    const warning = logs.getCalls('warn', 'project config invalid').at(-1);
    expect(warning?.payload.err).toBeInstanceOf(Error);
    expect((warning?.payload.err as Error).cause).toMatchObject({ code: 'YAML_PARSE' });

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

    // Mutate Y.Text under a normal origin so the persistence-hook fires
    // (no skipStoreHooks) and writes disk + updates LKG.
    const newContent = 'mcp:\n  autoStart: false\n';
    configDoc.transact(() => {
      ytext.insert(0, newContent);
    });

    const configPath = join(testProjectDir, '.ok', 'config.yml');
    const fileLanded = await waitFor(
      () => existsSync(configPath) && readFileSync(configPath, 'utf-8') === newContent,
    );
    expect(fileLanded).toBe(true);

    // Track all subsequent transactions for ~1s. The watcher will fire
    // because the disk file changed; applyExternalConfigChange must
    // short-circuit (LKG === content) and NOT mutate Y.Text again.
    const observedOrigins: unknown[] = [];
    configDoc.on('afterTransaction', (tx: { origin: unknown }) => {
      observedOrigins.push(tx.origin);
    });
    await new Promise((r) => setTimeout(r, 1_500));

    // Y.Text content must not have changed.
    expect(ytext.toString()).toBe(newContent);

    // No transactions fired with the file-watcher origin (which is what we
    // would see on a feedback loop).
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

// ─── file-watcher → engine.setMode loop ────────────────────────────────────
//
// Writing autoSync.enabled to <projectDir>/.ok/local/config.yml externally
// must propagate via the file watcher to the SyncEngine's mode (legacy
// `enabled: true` derives to `full`). Closes the persistence ↔ engine loop
// end-to-end without going through the client binding.

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

    // Engine boots disabled — neither config layer has autoSync.enabled.
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    // External writer (CLI / hand-edit / another agent) atomically creates
    // <projectDir>/.ok/local/config.yml with autoSync.enabled: true.
    const localDir = join(testProjectDir, '.ok', LOCAL_DIR);
    mkdirSync(localDir, { recursive: true });
    const configPath = join(localDir, 'config.yml');
    writeFileSync(configPath, 'autoSync:\n  enabled: true\n', 'utf-8');

    // Wait for file-watcher to detect the new file, applyExternalConfigChange
    // to update Y.Text, and the post-change handler to call
    // syncEngine.setMode(readProjectAutoSyncMode()).
    const flipped = await waitFor(() => srv.syncEngine?.getStatus().syncEnabled === true);
    expect(flipped).toBe(true);

    await srv.destroy();
  });

  test('toggling autoSync.enabled: false on disk disables the engine within 4s', async () => {
    // Boot with the engine enabled via project-local config.
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

    // Externally flip to false.
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

    // No per-machine answer and no committed default → engine boots disabled.
    expect(srv.syncEngine?.getStatus().syncEnabled).toBe(false);

    // A maintainer commits autoSync.default: true to <projectDir>/.ok/config.yml.
    // The committed-config watcher must re-run readProjectAutoSyncMode and,
    // because this machine is unanswered, seed the engine from the default.
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

// ─── removed key in project-local must not disable sync ─────────────────────
//
// A dead key sharing the project-local file with `autoSync.mode` used to
// invalidate the whole file (schema defaults substituted), so the real mode was
// discarded and sync resolved to `off`. Strip-and-continue keeps the mode live
// and reports the dead key as a diagnostic instead of treating it as a degraded
// read. `readLinkPreviewsEnabled`'s egress fail-closed direction is the mirror
// case: it must still trip on genuine corruption but not on a stripped key.

/**
 * Render a single removed-key entry into a nested object `{ a: { b: { leaf } } }`
 * so it can be serialized into a config fixture.
 */
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

  // The exact field regression: a dead `appearance.sidebar.showAllFiles` beside
  // `autoSync.mode: full` used to fall back to the committed default → `off`.
  test('a stale showAllFiles key beside autoSync.mode: full still resolves full and reports the removed key', async () => {
    writeProjectLocal(
      stringifyYaml({
        autoSync: { mode: 'full' },
        appearance: { sidebar: { showAllFiles: false } },
      }),
    );
    const srv = await boot();

    expect(srv.syncEngine?.getStatus().syncMode).toBe('full');

    // Assert the structured field, not the prose: `logConfigDiagnosticsOnce`
    // logs `{ scope, file, path }` as the payload and the human sentence as the
    // message, so `payload.path` is the stable contract and the message text is
    // free to be reworded. The message check only pins that the sentence a user
    // reads names the dead key too.
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

  // The same invariant across the whole registry: no dead key, whatever its
  // path, may reach `autoSync` and change the resolved mode.
  test.each(
    REMOVED_KEYS.map((entry) => ({ entry, dotted: entry.path.join('.') })),
  )('registry key $dotted beside autoSync.mode: full still resolves full', async ({ entry }) => {
    writeProjectLocal(
      stringifyYaml({ autoSync: { mode: 'full' }, ...nestRemovedKey(entry.path, false) }),
    );
    const srv = await boot();
    expect(srv.syncEngine?.getStatus().syncMode).toBe('full');
  });

  // A stripped removed key is a clean read, so the fail-closed egress guard does
  // not trip: an explicit opt-in resolves enabled. Read fresh after a live write
  // to exercise the no-restart contract.
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

  // Genuine degradation still fails egress closed — the per-field direction that
  // a stripped key must no longer trigger.
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
    // Pre-seed two markdown files so we can observe the visibility flip.
    mkdirSync(join(testProjectDir, 'drafts'), { recursive: true });
    writeFileSync(join(testProjectDir, 'keep.md'), '# Keep\n', 'utf-8');
    writeFileSync(join(testProjectDir, 'drafts', 'foo.md'), '# Foo\n', 'utf-8');

    const srv = createServer({
      contentDir: testProjectDir,
      projectDir: testProjectDir,
      quiet: true,
    });
    await srv.ready;

    // Pre-condition: drafts/foo.md is visible (no .okignore exists yet).
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

    // Hand-edit .okignore on disk — adds a pattern excluding drafts/.
    const okignorePath = join(testProjectDir, '.okignore');
    const newContent = 'drafts/\n';
    writeFileSync(okignorePath, newContent, 'utf-8');

    // Wait for: (1) Y.Text body reflects disk content, (2) ContentFilter
    // rebuild flips drafts/foo.md to excluded.
    const ytextSynced = await waitFor(() => ytext.toString() === newContent);
    expect(ytextSynced).toBe(true);

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('drafts/foo.md'));
    expect(filterUpdated).toBe(true);
    // keep.md must remain visible — it doesn't match the pattern.
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

    // Write a .gitignore that excludes logs/. The ContentFilter rebuild
    // should pick it up; the okignore Y.Text must remain untouched (no
    // gitignore-to-Y.Text association — gitignore is read-only inside OK).
    const gitignorePath = join(testProjectDir, '.gitignore');
    writeFileSync(gitignorePath, 'logs/\n', 'utf-8');

    const filterUpdated = await waitFor(() => srv.contentFilter.isExcluded('logs/debug.md'));
    expect(filterUpdated).toBe(true);
    expect(srv.contentFilter.isExcluded('index.md')).toBe(false);
    // okignore Y.Text untouched
    expect(ytext.toString()).toBe('');

    await srv.destroy();
  });

  test('persistence-hook write of __config__/okignore Y.Text ends in atomic .okignore on disk + ContentFilter visibility change', async () => {
    // Settings UI mutates Y.Text → atomic disk
    // write → watcher fires → applyExternalConfigChange short-circuits via LKG
    // (no Y.Text mutation, no feedback loop) → ContentFilter rebuilds.
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
    // Failure-mode regression: the watcher handler runs two operations on
    // each .okignore disk event — (1) mirror the new content into the
    // __config__/okignore Y.Text so the Settings pane re-renders; (2)
    // rebuild the ContentFilter so the file tree reflects the new ignore
    // set. These two operations serve different consumers and a failure
    // in (1) must not block (2). This test forces a throw inside the
    // mirror call by replacing the okignore Y.Doc's `transact` and
    // asserts the file tree filter still updates.
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

      // Inject a fault into the mirror path. `applyExternalConfigChange`
      // calls `document.transact(...)` after L3 validation; replacing
      // `transact` on this one instance forces a synchronous throw that
      // exercises the new try/catch in the watcher handler.
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

// ─── server-lock integration ──────────────────────────────────────────

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

    // The file survives, marked draining, until the process actually exits —
    // lock-gone must mean process-gone, so a successor can never overlap a
    // still-alive predecessor.
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

    // Seed a lock file with a real alive foreign PID to simulate a foreign
    // holder. The security validator refuses pid 1, so we use process.ppid
    // (the bun runner's parent) which is always > 1 in test environments.
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

    // Restore our own lock so destroy() cleans up
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
    // The lock is acquired before any side effect, HTTP listen included, so at
    // this point nothing is bound. `port` is the sentinel every consumer reads
    // as "the listener is accepting": the desktop's spawn gate admits a lock as
    // ready on `port > 0` and immediately opens a window against it. Stamping a
    // configured port here would make that gate fire before the socket exists,
    // so the port stays 0 until `updateServerLockPort` writes the bound one.
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

    // Inject Phase 2 failure: sessionManager.closeAll throws after normal cleanup
    const origCloseAll = server.sessionManager.closeAll.bind(server.sessionManager);
    server.sessionManager.closeAll = async () => {
      await origCloseAll();
      throw new Error('Injected Phase 2 failure');
    };

    await server.destroy();
    // Phase 6 still ran despite the phase-2 throw: our claim is released
    // (draining flag set); the file itself survives until process exit.
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

      // Both IDs are non-empty strings.
      expect(typeof serverA.serverInstanceId).toBe('string');
      expect(serverA.serverInstanceId.length).toBeGreaterThan(0);
      expect(typeof serverB.serverInstanceId).toBe('string');
      expect(serverB.serverInstanceId.length).toBeGreaterThan(0);

      // UUID v4 shape (8-4-4-4-12 hex with the `-4` version nibble).
      expect(serverA.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(serverB.serverInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Distinct between instances — this is the load-bearing property for
      // the CRDT restart-recovery defense: every server process advertises
      // a fresh ID so a client's cached prior ID will mismatch and force a
      // recycle before Yjs sync can merge stale state.
      expect(serverA.serverInstanceId).not.toBe(serverB.serverInstanceId);
    } finally {
      await serverA.destroy();
      await serverB.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// onAuthenticate enforcement for expectedServerInstanceId.
// Exercises the principalAuthExtension directly rather than through a live
// WebSocket — the hook is deterministic and the onAuthenticate contract is
// "throw with reason X → client sees authenticationFailed({reason: X})".
// Full end-to-end behavior is covered by the bug-class integration tests.
// ---------------------------------------------------------------------------
describe("createServer() — onAuthenticate rejects 'server-instance-mismatch'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-mismatch-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Pull the principalAuthExtension out of the configured Hocuspocus
  // extensions list via its `__kind: 'principal-auth'` marker. Matching on a
  // named marker is robust against future additions of other extensions
  // that also implement `onAuthenticate` — the `find` by function existence
  // alone would silently pick the wrong one.
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
      // Rejection happens before context mutation — no partial state leaks
      // through to the connection's identity.
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

      // No throw, and the principal path still hoisted the identity into ctx.
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

      // Anonymous path — no principal, no kind.
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

      // No throw — empty claim is legacy-equivalent and accepted.
      expect(context.kind).toBe('human');
    } finally {
      await server.destroy();
    }
  });
});

// expectedBranch is the late-join backstop for cross-branch invalidation:
// CC1 `branch-switched` is stateless (no replay), so a client offline
// during the broadcast misses it. The auth-token claim mirrors
// expectedServerInstanceId — server rejects on mismatch, client routes
// the rejection through handleBranchSwitched.
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
      // Server defaults activeBranch to 'main' when git is disabled or
      // not yet initialized — claim 'feature' to force the mismatch.
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
      // Rejection runs before context hoisting.
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
        expectedBranch: 'main', // server default
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

      // No throw — empty claim is legacy-equivalent and accepted.
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

// The branch gate compares a client claim against `getActiveBranch()`, which
// starts life as the DocumentDurabilityState `'main'` default and only becomes
// the workspace's real HEAD branch once `initAsync` runs
// `switchReconciledBaseScope(startupBranch)`. WebSocket connections are
// accepted from the moment `createServer()` returns, so without a readiness
// gate every cold-boot connect from a workspace on a non-`main` branch is
// rejected against a placeholder the server has no business comparing against.
// The rejection recycles the client pool, which re-arms the same 30s sync
// budget, which surfaces as a document that never loads.
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
      // Deliberately NOT awaiting `server.ready` — this is the cold-boot
      // window the reporter hit, where the durability state still holds the
      // `'main'` placeholder because `initAsync` has not resolved HEAD yet.
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
      // The message must name the resolved branch, not the placeholder — the
      // client adopts this value to correct its own claim.
      expect((thrown as { message?: string } | null)?.message).toContain('master');
    } finally {
      await server.destroy();
    }
  });

  // The gate must wait for the branch value and nothing else. Parking it on the
  // full boot promise instead would put the index rebuild, the O(n) seed walk,
  // the tag reconcile and the sync engine in front of WebSocket admission on
  // every branch — a tail the client's 30s sync budget outlives on a large
  // workspace, which is the same never-loading document from the other end.
  test('admission settles before the rest of boot does', async () => {
    const git = simpleGit(tmpDir);
    await git.init(['--initial-branch=master']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    // Enough files that the post-branch-resolution boot work (backlink rebuild,
    // seed walk, tag reconcile) is measurably slower than an auth handshake
    // that no longer waits for any of it. Kept modest on purpose: a bigger
    // vault widens the margin but its I/O spills onto the sibling workers
    // vitest runs in parallel and destabilizes timing tests elsewhere.
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

// ---------------------------------------------------------------------------
// A rejection thrown out of onAuthenticate refuses a document's WebSocket
// connection. Without a structured record it surfaces only as untimestamped
// Hocuspocus stderr, which cannot be bound to the session it wedged — so the
// warn line is the diagnostic surface, not a nicety.
// ---------------------------------------------------------------------------
describe('createServer() — onAuthenticate rejections reach the structured log', () => {
  let tmpDir: string;
  let logCapture: ReturnType<typeof captureAllLoggers>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-log-'));
    // Must precede createServer(): the factory resolves its logger once, at
    // construction time.
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
      // The offending peer address stays out of the structured fields — the
      // thrown message already carries it, and the log record is the
      // low-cardinality surface.
      expect(warns[0]?.payload).not.toHaveProperty('peer');
    } finally {
      await server.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Config-doc admission guard. The synthetic `__config__/project` and
// `__user__/config.yml` Y.Docs are pre-materialized at boot and remain
// resident; any client reaching `/collab` could otherwise open them by
// name and persist YAML to the user's config files. The guard rejects
// non-loopback peers and Host headers that don't match a loopback shape
// (DNS-rebinding defense — same pattern as `/api/*` mutating routes and
// the keepalive WS).
// ---------------------------------------------------------------------------
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
      // No throw — the gate only fires on config docs.
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
      // The `ok start --remote` alias shape: declared public origin + consent
      // on a loopback bind.
      ingressPolicy: buildIngressPolicy({
        serverRuntime: {
          port: undefined,
          bind: ['127.0.0.1'],
          externalUrl: 'https://myproject.ngrok.app',
          externalUrlSource: 'server',
          externalUrlFromDeprecatedKey: false,
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
      // The attacker-domain rejection is unchanged with a remote host configured.
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
      // Synthetic payloads in unit tests may omit `request.socket`. The gate
      // skips the peer check when the socket is unobservable, matching the
      // /api/* mutating-route convention; the Host-header rebinding defense
      // still fires (and accepts loopback hosts).
      await guard.onAuthenticate(
        makePayload({ documentName: '__config__/project', peer: undefined, host: 'localhost' }),
      );
    } finally {
      await server.destroy();
    }
  });

  test('config doc rejects attacker Host when peer is undefined (DNS rebinding with no socket)', async () => {
    // Pins the degraded-path single-layer defense: when the TCP peer check is
    // skipped because the socket is unobservable, the Host-header check is
    // the sole rebinding defense. A regression that short-circuits before the
    // Host check on undefined peer would silently open config-doc admission.
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
    // Pins the documented two-branch host resolution: prefer
    // `payload.requestHeaders.get('host')`, fall back to `req.headers.host`
    // when the Headers object is absent. The standard `makePayload` always
    // populates both, so the fallback branch is otherwise unexercised.
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
        // requestHeaders intentionally absent — forces fallback.
      } as unknown as Parameters<typeof guard.onAuthenticate>[0]);
    } finally {
      await server.destroy();
    }
  });
});

// ─── readProjectAutoSyncMode precedence + onAutoDisable scope ────────────
//
// readProjectAutoSyncMode reads the per-machine project-local
// autoSync.enabled first; when unanswered (null/absent) it falls back to the
// committed project-scope autoSync.default seed. A committed autoSync.enabled is
// deliberately ignored (project-local-scoped field → a committed value is a
// scope mismatch). onAutoDisable persists the auto-off flag to project-local so
// a teammate's machine never overrides another teammate's preference via git.

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
    // autoSync.enabled is a project-local-scoped field. A committed value is a
    // scope mismatch and must not seed the engine — only autoSync.default does.
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
    // Pins the !local.valid branch in readProjectAutoSyncMode. A corrupt
    // project-local file must not silently disable sync — the function logs and
    // falls back to the committed project default so the user keeps working
    // until the corruption is repaired.
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
    // A corrupt committed `.ok/config.yml` means autoSync.default can't be read,
    // so sync defaults to disabled (readProjectAutoSyncMode logs the
    // correlation). The machine is unanswered, so there is no project-local
    // value to fall back to — mirrors the project-local degraded path.
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
      // Small debounce so the natural unload path completes within the test.
      debounce: 50,
      maxDebounce: 100,
    });
    try {
      await server.ready;

      const docName = 'never-on-disk';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      // Don't write anything — simulates a flooding attacker that opens the
      // connection just to materialize a Y.Doc and then drops it.
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
      // The persistence onLoadDocument hook reads the disk file and seeds
      // reconciledBase, which must inhibit the phantom-doc unload path.
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
      await conn.disconnect();

      // Prove non-occurrence against a deterministic signal instead of a fixed
      // wall-clock window: a control phantom (no disk file, no content) opened
      // and disconnected AFTER the file-backed doc WILL unload. Once it's gone,
      // the unload sweep has run and the file-backed doc must have survived it.
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
      // Long debounce so onStoreDocument doesn't fire and set reconciledBase
      // before we measure — the property under test is "in-memory content
      // alone is enough to inhibit phantom unload".
      debounce: 60_000,
      maxDebounce: 60_000,
    });
    try {
      await server.ready;

      const docName = 'transient-with-content';
      const conn = await server.hocuspocus.openDirectConnection(docName);
      await conn.transact((doc) => {
        const fragment = doc.getXmlFragment('default');
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('user-typed-content')]);
        fragment.insert(0, [paragraph]);
      });
      await conn.disconnect();

      // Doc must remain resident so the next persistence cycle can durably
      // commit the user's bytes; phantom unload must NOT fire when content
      // exists even though reconciledBase is undefined.
      await new Promise((r) => setTimeout(r, 200));
      expect(server.hocuspocus.documents.has(docName)).toBe(true);
    } finally {
      await server.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// shouldUnloadDocument — forceUnloadSet branched guard.
//
// Pins the `forceUnloadSet.has(document)` branch in shouldUnloadDocument:
// membership returns true unconditionally, bypassing the default's
// `getConnectionsCount() === 0` gate AND the in-memory content-non-empty
// guards. Without this bypass, a "delete file → recreate with same name"
// flow leaves the old Y.Doc resident (the WS-teardown of any direct
// connection hasn't drained yet) and the next client reconnects to stale
// content. A refactor that re-couples this branch to the default's
// connection-count check must fail loudly.
// ---------------------------------------------------------------------------
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

      // Seed in-memory content so the default's content-non-empty guard would
      // refuse to unload. This is the precise state the delete-then-recreate
      // flow hits: the file is about to be unlinked, but the Y.Doc has bytes
      // from the pre-delete state. Without the forceUnloadSet bypass, those
      // bytes would re-hydrate the recreated doc on the next reconnect.
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
      localHttp = createNodeHttp((req, res) => {
        void apiExt.onRequest({ request: req, response: res });
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

      // Load-bearing assertion: doc removed despite the live direct connection
      // and the non-empty in-memory source text. The forceUnloadSet branch is
      // what makes this possible — a refactor that re-couples to
      // getConnectionsCount() or to the content-non-empty default guard would
      // leave the doc resident here.
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

// ---------------------------------------------------------------------------
// removalRedirectGuard registration + ordering. The algorithm itself is
// covered by the unit tests in `removal-redirect-guard.test.ts`. These
// tests pin the registration shape: the named marker exists, the
// extension carries `onAuthenticate`, and the order vs the existing two
// auth extensions (after `principalAuthExtension` and
// `configDocAdmissionGuard`, before `apiExtension`).
// ---------------------------------------------------------------------------
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
      // ordering: principal, config-guard, removal-redirect-guard.
      // `apiExtension` does not carry a `__kind` marker today; assert the
      // three named markers are in the documented order instead.
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
      // No cache state, no file — must admit (legitimate first-write may follow).
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

// ─── Production wiring: push-permission auth ────────────────────────────────
//
// The push-permission probe accepts auth via dependency injection at the
// SyncEngine boundary (`detectGh` + `tokenStore`), because `packages/server`
// cannot import from `packages/cli`. createServer's job is to forward those
// options through to `new SyncEngine({...})`. If this forwarding regresses,
// production runs the probe anonymously — the bug-report user's repo (public,
// read-only) lands on the worst classification path (no permission signal,
// AutoSyncOnboarding still mounts, user re-encounters the 403-on-push).
//
// These tests pin the forwarding chain. They use a github origin remote so
// the probe actually fires, inject a spy `checkPushPermissionFn` so we can
// observe the propagated arguments without hitting network, and assert that
// `detectGh` / `tokenStore` reach the spy unchanged.
describe('createServer() — push-permission auth wiring', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ok-auth-wiring-'));
    // Initialize a real git repo with a github origin so SyncEngine
    // detects hasRemote=true AND classifies the origin as 'github'.
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
    // Stubs: structurally distinct objects so we can prove identity propagation.
    const detectGhStub: DetectGhFn = (host?: string) => ({
      available: true,
      token: `stub-token-for-${host ?? 'github.com'}`,
    });
    const tokenStoreStub: ProbeTokenStore = {
      async get(host: string) {
        return { token: `store-token-for-${host}` };
      },
    };

    // Capture every probe-call's `opts.detectGh` + `opts.tokenStore`.
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
      tokenStore: tokenStoreStub,
      checkPushPermissionFn: probeSpy,
    });

    try {
      await server.ready;
      expect(server.syncEngine).not.toBeNull();

      // Force the probe to run synchronously rather than waiting for
      // start()'s non-blocking probe trigger. refreshPushPermission()
      // is the public manual-sync / auth-change entry point.
      await server.syncEngine?.refreshPushPermission();

      expect(probeCalls.length).toBeGreaterThan(0);
      const firstCall = probeCalls[0];
      // Identity equality, not structural — the seam must propagate the
      // EXACT objects, not copies. Anything else would mean the wiring
      // intercepted and replaced them, which would silently break gh-token
      // resolution under any future `host` param shape.
      expect(firstCall.detectGh).toBe(detectGhStub);
      expect(firstCall.tokenStore).toBe(tokenStoreStub);
      // The probe call shape must also carry owner/repo parsed from origin.
      expect(firstCall.owner).toBe('inkeep');
      expect(firstCall.repo).toBe('open-knowledge');
    } finally {
      await server.destroy();
    }
  });

  test('omitting detectGh + tokenStore leaves the probe call with undefined seams (no silent default substitution)', async () => {
    // Regression guard for the audit-revealed bug: a future "convenience"
    // refactor could decide to auto-resolve gh/tokenStore inside server-factory,
    // hiding the missing-wiring case from the package-isolation contract. This
    // test pins that omission really is omission — the seam types stay undefined
    // and the probe handles its own default (anonymous) downstream.
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
      // detectGh + tokenStore intentionally omitted
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

  /** The index that lives in a subdirectory, addressed by its content path. */
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

  /** A typed doc, which is the only shape the index renders. */
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

  /**
   * A real loopback HTTP endpoint bound to the booted server's api-extension, so
   * a test drives an agent write through the same request seam production does —
   * the seam that decides whether an API write schedules an index rebuild. The
   * server itself opens no listener; the api-extension is a Hocuspocus onRequest
   * handler, identified by its priority among the configured extensions.
   */
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
    localHttp = createNodeHttp((req, res) => {
      void apiExt.onRequest({ request: req, response: res });
    });
    await new Promise<void>((resolve) => localHttp?.listen(0, '127.0.0.1', resolve));
    const address = localHttp.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('local HTTP server did not bind to a port');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** Drive an agent markdown write through the API seam. */
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
    // Shadow repo needs contentDir under projectDir so `git add <contentRoot>`
    // has a valid pathspec — mirrors the real-world layout.
    contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    // Written as real YAML through the real config file, so the persisted →
    // runtime lift that silently dropped this key is on the tested path.
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

    // An index appearing at all is the end-to-end proof that
    // `contentRules.okf.generateIndex` survived YAML parse → persisted shape →
    // `toEffectiveBase` → the server's `=== true` gate. A key dropped anywhere
    // in that chain leaves this file absent forever.
    await waitForIndex((md) => md.includes('A note'));
    expect(readIndex()).toContain('okf_version: "0.2"');
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
    // The entry lives in the folder's index, relative to that folder…
    await waitForIndexAt('concepts', (md) => md.includes('* [First](./first.md)'));
    // …and the root links the child index — written after it, deepest-first —
    // rather than the document itself.
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
    // The regression that shipped: `case 'delete'` returns early when the
    // document is not resident, and that branch skipped the rebuild — so the
    // index kept a link to a file that no longer existed. Nothing here ever
    // opens the doc, which is exactly the common case.
    await bootServer();
    writeDoc('concepts/doomed.md', 'Doomed', 'concept');
    writeDoc('concepts/survivor.md', 'Survivor', 'concept');
    await waitForIndexAt('concepts', (md) => md.includes('./doomed.md'));

    unlinkSync(join(contentDir, 'concepts', 'doomed.md'));

    await waitForIndexAt('concepts', (md) => !md.includes('./doomed.md'));
    // The rest of the folder survives — this is a rebuild, not a truncation.
    expect(readIndexAt('concepts')).toContain('./survivor.md');
  });

  test('an emptied section disappears rather than lingering as a bare heading', async () => {
    await bootServer();
    writeDoc('only.md', 'Only', 'solo-type');
    writeDoc('keep.md', 'Keep', 'note');
    await waitForIndex((md) => md.includes('## solo-type'));

    unlinkSync(join(contentDir, 'only.md'));

    await waitForIndex((md) => !md.includes('## solo-type'));
    expect(readIndex()).toContain('## note');
  });

  test('a cross-directory rename through the watcher drops the source entry and lands the destination', async () => {
    // `concepts` keeps a second document so it stays in the index set and is
    // rebuilt to drop the moved entry, isolating the source-directory fix from
    // the unrelated case of a directory losing its last document. `archive`
    // starts populated so this is a plain move between two already-indexed
    // folders, where the stale-source defect actually bites.
    writeDoc('concepts/mover.md', 'Mover', 'concept');
    writeDoc('concepts/keeper.md', 'Keeper', 'concept');
    writeDoc('archive/anchor.md', 'Anchor', 'note');
    await bootServer();
    await waitForIndexAt('concepts', (md) => md.includes('./mover.md'));
    await waitForIndexAt('archive', (md) => md.includes('./anchor.md'));

    // Moving the exact bytes lets the watcher pair the same-batch delete+create
    // by content hash into one `rename` event — the composed path the fix lives
    // on. A split into a separate delete and create would each schedule their
    // own directory, so the source would never go stale and the rename path
    // would go unproven.
    renameSync(join(contentDir, 'concepts', 'mover.md'), join(contentDir, 'archive', 'mover.md'));

    // Endpoint-shaped: the destination lists the moved document and the source
    // no longer does, while the source keeps its other entry.
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
        // The whole point of the writer: generated bytes carry their own
        // authorship instead of riding on whichever writer happens to drain.
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
    // The byte-compare fixed point. Writing the index mutates the file index and
    // signals `files`, so a generator that wrote unconditionally would keep a
    // tracked file permanently dirty in `git status` — and, if a future trigger
    // ever fires on its own write, spin.
    //
    // The probe is a RESERVED file: creating `log.md` is a real watcher create,
    // so a rebuild genuinely runs — but `log` is never an entry, so the bytes it
    // computes are identical to what is already on disk. Exactly the case the
    // compare exists to absorb.
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

    // The rebuild ran and decided to do nothing — the file is untouched, not
    // merely unchanged in content.
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
            file: 'content/concepts/index.md',
            detectedAt: '2026-08-07T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );
    const conflictedMtime = statSync(indexPathAt('concepts')).mtimeMs;

    const logCapture = captureAllLoggers();
    await bootServer();
    expect(server?.hocuspocus.documents.has('concepts/index')).toBe(false);
    expect(server?.syncEngine?.getConflicts()).toEqual([
      expect.objectContaining({ file: 'content/concepts/index.md' }),
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

    await server?.syncEngine?.reconcileConflictsFromGit();
    expect(server?.syncEngine?.getConflicts()).toEqual([]);
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
        expect(document?.getMap('lifecycle').get('status')).toBe('conflict');
        expect(document?.getMap('lifecycle').get('reason')).toBe('conflict-markers');
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
    expect(document?.getMap('lifecycle').get('status')).toBe('conflict');
    expect(document?.getMap('lifecycle').get('reason')).toBe('conflict-markers');

    writeFileSync(indexPathAt('concepts'), canonical, 'utf-8');
    await vi.waitFor(
      () => {
        expect(document?.getMap('lifecycle').get('status')).toBeUndefined();
        expect(document?.getMap('lifecycle').get('reason')).toBeUndefined();
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
    // The least-exercised path in the feature, and the one hardest to pin
    // honestly: asserting only that the open document converges passes even
    // when the CRDT branch is dead, because the disk write plus the watcher
    // round-trip gets there too. That green would be a false pass — the
    // dangerous code never ran.
    //
    // So assert the ORIGIN of the update that moved the document. Only the
    // paired CRDT write carries `generated-index`; bytes arriving by way of the
    // watcher carry the file-watcher's origin instead.
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

    // The open editor's view converged — the outcome the branch exists for.
    await vi.waitFor(
      () => {
        const live = doc?.getText('source').toString() ?? '';
        expect(live).toContain('./second.md');
        expect(live).toContain('./first.md');
      },
      { timeout: 20_000, interval: 50 },
    );

    // …and it converged by the intended route.
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

    // Retitle the alpha document — an index-visible change scoped to alpha.
    writeDoc('alpha/a.md', 'A renamed', 'note');
    await waitForIndexAt('alpha', (md) => md.includes('[A renamed]') && !md.includes('[A one]'));

    // The sibling was never rewritten: same bytes, same file, untouched. This is
    // the "and no other" half — an edit's cost stays with its own directory.
    expect(readIndexAt('beta')).toBe(betaBefore);
    expect(statSync(indexPathAt('beta')).mtimeMs).toBe(betaMtimeBefore);
  });

  test('editing only body prose rebuilds no index', async () => {
    await bootServer();
    writeDoc('notes/n.md', 'A note', 'note', 'A description.');
    await waitForIndexAt('notes', (md) => md.includes('[A note]'));

    const before = readIndexAt('notes');
    const mtimeBefore = statSync(indexPathAt('notes')).mtimeMs;

    // Identical frontmatter and title; only the body below the heading changes,
    // so nothing the index renders has moved.
    writeFileSync(
      join(contentDir, 'notes', 'n.md'),
      '---\ntitle: A note\ntype: note\ndescription: A description.\n---\n\n# A note\n\nRewritten prose.\n',
      'utf-8',
    );

    // Long enough to clear the 500 ms regeneration debounce several times over.
    await new Promise((r) => setTimeout(r, 3_000));

    expect(readIndexAt('notes')).toBe(before);
    expect(statSync(indexPathAt('notes')).mtimeMs).toBe(mtimeBefore);
  });

  test('an agent write through the API that changes a field rebuilds its folder index', async () => {
    await bootServer();
    writeDoc('notes/n.md', 'Before', 'note', 'A description.');
    await waitForIndexAt('notes', (md) => md.includes('[Before]'));
    const api = await apiBaseUrl();

    // Retitle through the agent write seam. `replace` with new frontmatter
    // supersedes the old, so a field the index renders genuinely moves — the
    // seam must schedule the rebuild rather than treating the write like prose.
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

    // Identical frontmatter and title, only the body below the heading changes —
    // the API counterpart of the disk-path prose test above. The field predicate
    // gates this seam too, so a prose-only write schedules no rebuild.
    await agentWriteMd(
      api,
      'notes/n',
      '---\ntitle: A note\ntype: note\ndescription: A description.\n---\n\n# A note\n\nRewritten prose.\n',
    );

    // Long enough to clear the 500 ms regeneration debounce several times over.
    await new Promise((r) => setTimeout(r, 3_000));

    expect(readIndexAt('notes')).toBe(before);
    expect(statSync(indexPathAt('notes')).mtimeMs).toBe(mtimeBefore);
  });

  test('deleting a populated subdirectory drops it from its parent index', async () => {
    await bootServer();
    writeDoc('area/top.md', 'Top', 'note');
    writeDoc('area/sub/deep.md', 'Deep', 'note');
    // The parent carries both its own document and a link to the subdirectory.
    await waitForIndexAt('area', (md) => md.includes('* [sub](./sub/index.md)'));
    expect(readIndexAt('area')).toContain('./top.md');

    rmSync(join(contentDir, 'area', 'sub'), { recursive: true, force: true });

    // The parent drops the subdirectory link. Reaching `area` at all depends on
    // the folder-delete invalidating the ancestor chain; the per-document delete
    // alone would only schedule the now-empty `area/sub`.
    await waitForIndexAt('area', (md) => !md.includes('./sub/index.md'));
    // …while keeping its own document — a rebuild, not a truncation.
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
    // Three writes across two directories with no await between them, so they
    // land inside one debounce window.
    writeDoc('one/a.md', 'A', 'note');
    writeDoc('one/b.md', 'B', 'note');
    writeDoc('two/c.md', 'C', 'note');

    // Both edits to `one` coalesce into its single index rather than racing.
    await waitForIndexAt('one', (md) => md.includes('[A]') && md.includes('[B]'));
    await waitForIndexAt('two', (md) => md.includes('[C]'));
    // The root links both folders it grew (written last, deepest-first).
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

    // A lifecycle enable carries no directory, so the whole tree is swept: the
    // nested index appears, and the root links it (written last, deepest-first).
    await waitForIndexAt('deep', (md) => md.includes('[Leaf]'));
    await waitForIndex((md) => md.includes('./deep/index.md'));
  });

  test("a document in a pre-existing folder reaches the folder's parent index", async () => {
    // The folder is on disk before boot, so its first document fires no
    // folder-create — only the document event, which schedules just the folder's
    // own index, not its parent chain. So the parent learns of the folder solely
    // because writing the new child index re-schedules the parent. Remove that
    // re-schedule and the parent stays stale forever: the child index's own write
    // event is refused by the self-trigger guard, so nothing else re-teaches it.
    mkdirSync(join(contentDir, 'concepts'), { recursive: true });
    writeDoc('anchor.md', 'Anchor', 'note');
    await bootServer();

    // The root settles at boot listing the anchor and does not yet link the
    // still-empty folder.
    await waitForIndex((md) => md.includes('[Anchor]'));
    expect(readIndex()).not.toContain('./concepts/index.md');

    // The folder's first document. `writeDoc`'s mkdir is a no-op here, so no
    // folder-create rides along to carry the news to the parent.
    writeDoc('concepts/first.md', 'First', 'concept');

    // The folder's own index appears…
    await waitForIndexAt('concepts', (md) => md.includes('* [First](./first.md)'));
    // …and the parent links it, with no second edit and no restart.
    await waitForIndex((md) => md.includes('* [concepts](./concepts/index.md)'));

    // The walk terminates: once the parent settles it does not re-trigger the
    // child, so the child index is written once and then left untouched.
    const childMtime = statSync(indexPathAt('concepts')).mtimeMs;
    const rootMtime = statSync(indexPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(statSync(indexPathAt('concepts')).mtimeMs).toBe(childMtime);
    expect(statSync(indexPath()).mtimeMs).toBe(rootMtime);
  });

  test('a cold boot converges a multi-depth tree in a single pass', async () => {
    // Markdown at three depths, plus a container whose only markdown lives in a
    // descendant — all present before the server exists. The helper waits for
    // the explicit boot-sweep settlement, so asserting immediately afterward
    // with no polling proves one pass suffices for the whole tree.
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

    // Every markdown-bearing directory has an index, including the container that
    // holds no document of its own.
    expect(existsSync(indexPath())).toBe(true);
    for (const dir of ['topic', 'topic/deep', 'container', 'container/leaf']) {
      expect(existsSync(indexPathAt(dir))).toBe(true);
    }

    // The root carries its own document and links each top-level subdirectory's
    // index — the child index document, never the documents nested inside it.
    const root = readIndex();
    expect(root).toContain('* [Root note](./root-note.md)');
    expect(root).toContain('* [container](./container/index.md)');
    expect(root).toContain('* [topic](./topic/index.md)');
    expect(root).not.toContain('./topic/overview.md');

    // A mid-level directory links its deeper child index. A top-down sweep would
    // have written this parent before that child index existed and needed a
    // second corrective pass to gain the link.
    const topic = readIndexAt('topic');
    expect(topic).toContain('* [Overview](./overview.md)');
    expect(topic).toContain('* [deep](./deep/index.md)');

    // The deepest directory carries its own document and no subdirectory section.
    const deep = readIndexAt('topic/deep');
    expect(deep).toContain('* [Detail](./detail.md)');
    expect(deep).not.toContain('## Subdirectories');

    // The container navigates purely by its subdirectory link — no empty type
    // section for a document it does not hold.
    const container = readIndexAt('container');
    expect(container).toContain('* [leaf](./leaf/index.md)');
    expect(container).not.toContain('## note');
    expect(readIndexAt('container/leaf')).toContain('* [Item](./item.md)');
  });

  test('a second boot over a converged tree rewrites no index', async () => {
    // The same multi-depth tree, converged by the first boot.
    writeDoc('root-note.md', 'Root note', 'note');
    writeDoc('topic/overview.md', 'Overview', 'concept');
    writeDoc('topic/deep/detail.md', 'Detail', 'concept');
    writeDoc('container/leaf/item.md', 'Item', 'note');
    await bootServer();

    // Snapshot every index's bytes and mtime once the first boot has settled.
    const indexed = ['', 'topic', 'topic/deep', 'container', 'container/leaf'];
    const snapshot = indexed.map((dir) => {
      const path = dir === '' ? indexPath() : indexPathAt(dir);
      return { path, bytes: readFileSync(path, 'utf-8'), mtime: statSync(path).mtimeMs };
    });

    // A second cold boot is a second full sweep over unchanged content. Boot runs
    // the sweep unconditionally, so it genuinely re-plans every index — and the
    // per-index byte comparison suppresses each write because the bytes on disk
    // already match. A sweep that oscillated would rewrite at least one file.
    await server?.destroy();
    await bootServer();

    for (const { path, bytes, mtime } of snapshot) {
      expect(readFileSync(path, 'utf-8')).toBe(bytes);
      expect(statSync(path).mtimeMs).toBe(mtime);
    }
  });
});
