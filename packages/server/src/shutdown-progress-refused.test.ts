import { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { getLogger } from './logger.ts';
import { ensureProjectGit } from './project-git.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { initShadowRepo } from './shadow-repo.ts';

const homeState = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeState.path ?? actual.homedir() };
});

const normalName = 'normal-shutdown-doc';
const refusedName = 'refused-shutdown-doc';
const innerBudget = 10_000;
const unsavedMarker = 'Unflushed content held through shutdown.';

async function executePendingStore(server: ServerInstance, docName: string): Promise<void> {
  const debounceId = `onStoreDocument-${docName}`;
  expect(server.hocuspocus.debouncer.isDebounced(debounceId)).toBe(true);
  const pending = server.hocuspocus.debouncer.executeNow(debounceId);
  expect(pending).toBeDefined();
  await pending;
}

async function withRefusedStoreShutdown(
  run: (fixture: {
    server: ServerInstance;
    gates: Map<string, PromiseWithResolvers<void>>;
    entered: Map<string, PromiseWithResolvers<void>>;
    unloaded: Map<string, PromiseWithResolvers<void>>;
    observations: Array<{ event: string; loaded: string[] }>;
    rescuePath: string;
    flushBegan: Promise<void>;
    forcedRefusedUnloadBegan: Promise<void>;
    blockedSignalRequests: Array<{
      pid: number | undefined;
      signal: string | number | undefined;
    }>;
  }) => Promise<void>,
): Promise<void> {
  const blockedSignalRequests: Array<{
    pid: number | undefined;
    signal: string | number | undefined;
  }> = [];
  const probe = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0) return probe(pid, signal);
    blockedSignalRequests.push({ pid, signal });
    throw new Error('Test signal seam refuses delivery');
  });
  vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
    this: ChildProcess,
    signal,
  ) {
    blockedSignalRequests.push({ pid: this.pid, signal });
    return false;
  });
  const homeDir = await mkdtemp(join(tmpdir(), 'ok-shutdown-refused-home-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'ok-shutdown-refused-'));
  homeState.path = homeDir;
  const contentDir = join(projectDir, 'content');
  const refusedPath = join(contentDir, `${refusedName}.md`);
  const gates = new Map(
    [normalName, refusedName].map((name) => [name, Promise.withResolvers<void>()]),
  );
  const entered = new Map(
    [normalName, refusedName].map((name) => [name, Promise.withResolvers<void>()]),
  );
  const unloaded = new Map(
    [normalName, refusedName].map((name) => [name, Promise.withResolvers<void>()]),
  );
  const observations: Array<{ event: string; loaded: string[] }> = [];
  let server: ServerInstance | undefined;
  try {
    await mkdir(contentDir, { recursive: true });
    await ensureProjectGit(projectDir);
    configureTestGitRepository(projectDir);
    const shadowHandle = await initShadowRepo(projectDir);
    const refusedInitial = '# Refused shutdown doc\n\nPersisted paragraph.\n';
    writeFileSync(refusedPath, refusedInitial, 'utf-8');
    writeFileSync(join(contentDir, `${normalName}.md`), '# Normal shutdown doc\n', 'utf-8');
    writeFileSync(
      join(projectDir, '.okignore'),
      `content/${normalName}.md\ncontent/${refusedName}.md\n`,
      'utf-8',
    );
    server = createServer({
      contentDir,
      projectDir,
      quiet: true,
      shadowRepo: shadowHandle,
    });
    await server.ready;
    const hp = server.hocuspocus;
    const refusedConnection = await hp.openDirectConnection(refusedName);
    const refusedDoc = hp.documents.get(refusedName);
    expect(refusedDoc).toBeDefined();
    if (!refusedDoc) throw new Error('Refused document was not loaded');
    expect(server.durabilityState.getReconciledBase(refusedName)).toBe(refusedInitial);
    rmSync(refusedPath);
    mkdirSync(refusedPath);
    server.durabilityState.deleteReconciledBase(refusedName);
    await refusedConnection.transact((doc) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(unsavedMarker)]);
      doc.getXmlFragment('default').insert(0, [paragraph]);
    });
    await executePendingStore(server, refusedName);
    expect(server.durabilityState.isStoreRefused(refusedName)).toBe(true);
    const rescuePath = join(shadowHandle.gitDir, 'rescue', `${refusedName}.md`);
    expect(existsSync(rescuePath)).toBe(true);
    expect(readFileSync(rescuePath, 'utf-8')).toContain(unsavedMarker);

    await hp.openDirectConnection(normalName);
    const normalDoc = hp.documents.get(normalName);
    expect(normalDoc).toBeDefined();
    if (!normalDoc) throw new Error('Normal document was not loaded');
    hp.configuration.extensions.push({
      beforeUnloadDocument({ documentName }) {
        entered.get(documentName)?.resolve();
        return gates.get(documentName)?.promise ?? Promise.resolve();
      },
      afterUnloadDocument({ documentName }) {
        if (unloaded.has(documentName)) {
          observations.push({
            event: documentName,
            loaded: [normalName, refusedName].filter((name) => hp.documents.has(name)),
          });
          unloaded.get(documentName)?.resolve();
        }
        return Promise.resolve();
      },
    });
    refusedDoc.removeDirectConnection();
    normalDoc.removeDirectConnection();
    expect(hp.documents.has(refusedName)).toBe(true);
    expect(hp.documents.has(normalName)).toBe(true);

    const flushBegan = Promise.withResolvers<void>();
    const forcedRefusedUnloadBegan = Promise.withResolvers<void>();
    let flushObserved = false;
    const flushPendingStores = hp.flushPendingStores.bind(hp);
    vi.spyOn(hp, 'flushPendingStores').mockImplementation(() => {
      const result = flushPendingStores();
      flushObserved = true;
      flushBegan.resolve();
      return result;
    });
    const shouldUnloadDocument = hp.shouldUnloadDocument.bind(hp);
    vi.spyOn(hp, 'shouldUnloadDocument').mockImplementation((document) => {
      const result = shouldUnloadDocument(document);
      if (flushObserved && document.name === refusedName && result) {
        forcedRefusedUnloadBegan.resolve();
      }
      return result;
    });
    await run({
      server,
      gates,
      entered,
      unloaded,
      observations,
      rescuePath,
      flushBegan: flushBegan.promise,
      forcedRefusedUnloadBegan: forcedRefusedUnloadBegan.promise,
      blockedSignalRequests,
    });
  } finally {
    for (const gate of gates.values()) gate.resolve();
    vi.useRealTimers();
    await server?.destroy();
    vi.restoreAllMocks();
    homeState.path = undefined;
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('factory shutdown keeps a refused-store unload pending while other documents retire', async () => {
  await withRefusedStoreShutdown(
    async ({
      server,
      gates,
      entered,
      unloaded,
      observations,
      rescuePath,
      flushBegan,
      forcedRefusedUnloadBegan,
      blockedSignalRequests,
    }) => {
      const hp = server.hocuspocus;
      const warnings = vi.spyOn(getLogger('server'), 'warn');
      const errors = vi.spyOn(getLogger('server'), 'error');
      const refusedDeadlineWarnings = () =>
        warnings.mock.calls.filter(([fields, message]) => {
          if (!fields || typeof fields !== 'object') return false;
          return (
            (fields as { docName?: unknown }).docName === refusedName &&
            typeof message === 'string' &&
            message.includes('did not finish before the flush deadline')
          );
        });
      const flushTimeoutReports = () =>
        errors.mock.calls.filter(([fields]) => {
          if (!fields || typeof fields !== 'object') return false;
          const report = fields as { err?: unknown };
          return (
            report.err instanceof Error &&
            report.err.message.startsWith('flushAllStoresAndWait timeout')
          );
        });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const destroyed = server.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await flushBegan;
      await forcedRefusedUnloadBegan;
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      expect(server.durabilityState.isStoreRefused(refusedName)).toBe(true);
      expect(hp.documents.has(refusedName)).toBe(true);
      await vi.advanceTimersByTimeAsync(innerBudget * 0.4);
      gates.get(normalName)?.resolve();
      await unloaded.get(normalName)?.promise;
      expect(observations).toEqual([{ event: normalName, loaded: [refusedName] }]);
      await vi.advanceTimersByTimeAsync(innerBudget * 0.8);
      expect(blockedSignalRequests).toEqual([]);
      expect(hp.documents.has(refusedName)).toBe(true);
      expect(refusedDeadlineWarnings()).toEqual([]);
      expect(flushTimeoutReports()).toEqual([]);
      gates.get(refusedName)?.resolve();
      await unloaded.get(refusedName)?.promise;
      vi.useRealTimers();
      const result = await destroyed;
      expect(result).toEqual({ status: 'fulfilled' });
      expect(observations.map((entry) => entry.loaded.length)).toEqual([1, 0]);
      expect(refusedDeadlineWarnings()).toEqual([]);
      expect(flushTimeoutReports()).toEqual([]);
      expect(readFileSync(rescuePath, 'utf-8')).toContain(unsavedMarker);
      expect(blockedSignalRequests).toEqual([]);
    },
  );
});

test('factory shutdown bounds a refused-store unload that stalls after other documents retire', async () => {
  await withRefusedStoreShutdown(
    async ({
      server,
      gates,
      entered,
      unloaded,
      observations,
      rescuePath,
      flushBegan,
      forcedRefusedUnloadBegan,
      blockedSignalRequests,
    }) => {
      const hp = server.hocuspocus;
      const serverLogger = getLogger('server');
      const error = serverLogger.error.bind(serverLogger);
      const isFlushTimeoutReport = (fields: unknown) => {
        if (!fields || typeof fields !== 'object') return false;
        const report = fields as { err?: unknown };
        return (
          report.err instanceof Error &&
          report.err.message.startsWith('flushAllStoresAndWait timeout')
        );
      };
      const warnings = vi.spyOn(serverLogger, 'warn');
      const errors = vi.spyOn(serverLogger, 'error').mockImplementation((fields, message) => {
        const result = error(fields, message);
        if (isFlushTimeoutReport(fields)) vi.useRealTimers();
        return result;
      });
      const refusedDeadlineWarnings = () =>
        warnings.mock.calls.filter(([fields, message]) => {
          if (!fields || typeof fields !== 'object') return false;
          return (
            (fields as { docName?: unknown }).docName === refusedName &&
            typeof message === 'string' &&
            message.includes('did not finish before the flush deadline')
          );
        });
      const flushTimeoutReports = () =>
        errors.mock.calls.filter(([fields]) => isFlushTimeoutReport(fields));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const destroyed = server.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await flushBegan;
      await forcedRefusedUnloadBegan;
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      expect(server.durabilityState.isStoreRefused(refusedName)).toBe(true);
      expect(hp.documents.has(refusedName)).toBe(true);
      const normalRetiresAfter = innerBudget * 0.4;
      await vi.advanceTimersByTimeAsync(normalRetiresAfter);
      gates.get(normalName)?.resolve();
      await unloaded.get(normalName)?.promise;
      expect(observations).toEqual([{ event: normalName, loaded: [refusedName] }]);
      await vi.advanceTimersByTimeAsync(innerBudget * 0.8);
      expect(refusedDeadlineWarnings()).toEqual([]);
      expect(flushTimeoutReports()).toEqual([]);
      expect(hp.documents.has(refusedName)).toBe(true);
      await vi.advanceTimersByTimeAsync(innerBudget);
      expect(refusedDeadlineWarnings()).toHaveLength(1);
      const deadlineFields = refusedDeadlineWarnings()[0]?.[0] as
        | { unloadDeadline?: number }
        | undefined;
      expect(deadlineFields?.unloadDeadline).toBe(normalRetiresAfter + innerBudget);
      expect(flushTimeoutReports()).toHaveLength(1);
      expect(hp.documents.has(refusedName)).toBe(true);
      expect(blockedSignalRequests).toEqual([]);
      gates.get(refusedName)?.resolve();
      await unloaded.get(refusedName)?.promise;
      vi.useRealTimers();
      const result = await destroyed;
      expect(result).toEqual({ status: 'fulfilled' });
      expect(readFileSync(rescuePath, 'utf-8')).toContain(unsavedMarker);
      expect(blockedSignalRequests).toEqual([]);
    },
  );
});
