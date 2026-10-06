import { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { getLogger } from './logger.ts';
import { ensureProjectGit } from './project-git.ts';

const homeState = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeState.path ?? actual.homedir() };
});

const names = ['first', 'second', 'third'];
const outerBudget = Number(process.env.OK_DESTROY_STEP_TIMEOUT_MS) || 5000;
const innerBudget = 10_000;

function captureShutdownReports() {
  const firstReport = Promise.withResolvers<'outer' | 'inner'>();
  const bootLogger = getLogger('boot');
  const serverLogger = getLogger('server');
  const warn = bootLogger.warn.bind(bootLogger);
  const error = serverLogger.error.bind(serverLogger);
  const isOuterTimeout = (fields: unknown) => {
    if (!fields || typeof fields !== 'object') return false;
    const report = fields as { step?: unknown; err?: unknown };
    return (
      report.step === 'destroyHocuspocus' &&
      report.err instanceof Error &&
      report.err.message === `destroyHocuspocus timed out: no document retired for ${outerBudget}ms`
    );
  };
  const isInnerTimeout = (fields: unknown, message: unknown) => {
    if (!fields || typeof fields !== 'object') return false;
    const report = fields as { err?: unknown };
    return (
      message === '[server] shutdown phase-3 flush failed' &&
      report.err instanceof Error &&
      report.err.message.startsWith(
        `flushAllStoresAndWait timeout: no document retired for ${innerBudget}ms`,
      )
    );
  };
  const bootWarnings = vi.spyOn(bootLogger, 'warn').mockImplementation((fields, message) => {
    const result = warn(fields, message);
    if (isOuterTimeout(fields)) {
      vi.useRealTimers();
      firstReport.resolve('outer');
    }
    return result;
  });
  const factoryErrors = vi.spyOn(serverLogger, 'error').mockImplementation((fields, message) => {
    const result = error(fields, message);
    if (isInnerTimeout(fields, message)) {
      vi.useRealTimers();
      firstReport.resolve('inner');
    }
    return result;
  });
  return {
    firstReport: firstReport.promise,
    outer: () => bootWarnings.mock.calls.filter(([fields]) => isOuterTimeout(fields)),
    inner: () =>
      factoryErrors.mock.calls.filter(([fields, message]) => isInnerTimeout(fields, message)),
  };
}

async function withLoadedDocuments(
  run: (fixture: {
    booted: Awaited<ReturnType<typeof bootServer>>;
    gates: Map<string, PromiseWithResolvers<void>>;
    entered: Map<string, PromiseWithResolvers<void>>;
    unloaded: Map<string, PromiseWithResolvers<void>>;
    observations: Array<{ event: string; loaded: string[] }>;
    retirements: string[];
    acknowledgeBootRejection: () => void;
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
  const homeDir = await mkdtemp(join(tmpdir(), 'ok-shutdown-home-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'ok-shutdown-progress-'));
  homeState.path = homeDir;
  let booted: Awaited<ReturnType<typeof bootServer>> | undefined;
  let startedBootDestroy: Promise<void> | undefined;
  let bootRejectionAcknowledged = false;
  const gates = new Map(names.map((name) => [name, Promise.withResolvers<void>()]));
  const entered = new Map(names.map((name) => [name, Promise.withResolvers<void>()]));
  const unloaded = new Map(names.map((name) => [name, Promise.withResolvers<void>()]));
  const observations: Array<{ event: string; loaded: string[] }> = [];
  const retirements: string[] = [];
  let bodyError: unknown;
  let bodyFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    await ensureProjectGit(projectDir);
    configureTestGitRepository(projectDir);
    await mkdir(join(projectDir, '.ok'), { recursive: true });
    await writeFile(join(projectDir, '.ok', 'config.yml'), '');
    for (const name of names) await writeFile(join(projectDir, `${name}.md`), `# ${name}\n`);
    booted = await bootServer({
      host: '127.0.0.1',
      config: ConfigSchema.parse({}),
      contentDir: projectDir,
      configHomedirOverride: homeDir,
      port: 0,
      quiet: true,
      gitEnabled: false,
      idleShutdownMs: null,
      ephemeral: true,
    });
    await booted.ready;
    const destroyBoot = booted.destroy.bind(booted);
    booted.destroy = (reason) => {
      const inFlight = destroyBoot(reason);
      startedBootDestroy ??= inFlight;
      return inFlight;
    };
    const hp = booted.serverInstance.hocuspocus;
    for (const name of names) {
      const connection = await hp.openDirectConnection(name);
      await connection.disconnect();
    }
    expect(names.every((name) => hp.documents.has(name))).toBe(true);
    hp.configuration.extensions.push({
      beforeUnloadDocument({ documentName }) {
        entered.get(documentName)?.resolve();
        return gates.get(documentName)?.promise ?? Promise.resolve();
      },
      afterUnloadDocument({ documentName }) {
        retirements.push(documentName);
        if (unloaded.has(documentName)) {
          observations.push({
            event: documentName,
            loaded: names.filter((name) => hp.documents.has(name)),
          });
          unloaded.get(documentName)?.resolve();
        }
        return Promise.resolve();
      },
    });
    await run({
      booted,
      gates,
      entered,
      unloaded,
      observations,
      retirements,
      acknowledgeBootRejection: () => {
        bootRejectionAcknowledged = true;
      },
      blockedSignalRequests,
    });
  } catch (error) {
    bodyError = error;
    bodyFailed = true;
  } finally {
    for (const gate of gates.values()) gate.resolve();
    try {
      await booted?.serverInstance.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      vi.useRealTimers();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (startedBootDestroy) await startedBootDestroy;
      else await booted?.destroy();
    } catch (error) {
      if (!bootRejectionAcknowledged) cleanupErrors.push(error);
    }
    try {
      vi.restoreAllMocks();
    } catch (error) {
      cleanupErrors.push(error);
    }
    homeState.path = undefined;
    try {
      await rm(projectDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(homeDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (bodyFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors],
        'Shutdown fixture and cleanup failed',
      );
    }
    throw bodyError;
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'Shutdown fixture cleanup failed');
  }
}

test('destroy accepts real document unload progress across the outer deadline', async () => {
  await withLoadedDocuments(
    async ({ booted, gates, entered, unloaded, observations, blockedSignalRequests }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const destroyed = booted.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      for (const name of names) {
        await vi.advanceTimersByTimeAsync(outerBudget * 0.4);
        gates.get(name)?.resolve();
        await unloaded.get(name)?.promise;
      }
      vi.useRealTimers();
      const result = await destroyed;
      await booted.serverInstance.destroy();
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2, 1, 0]);
      expect(blockedSignalRequests).toEqual([]);
      expect(result).toEqual({ status: 'fulfilled' });
    },
  );
});

test('destroy reports a held real document unload without waiting for its release', async () => {
  await withLoadedDocuments(
    async ({
      booted,
      gates,
      entered,
      unloaded,
      observations,
      retirements,
      acknowledgeBootRejection,
      blockedSignalRequests,
    }) => {
      const hp = booted.serverInstance.hocuspocus;
      const flushBegan = Promise.withResolvers<void>();
      const flushPendingStores = hp.flushPendingStores.bind(hp);
      vi.spyOn(hp, 'flushPendingStores').mockImplementation(() => {
        const result = flushPendingStores();
        flushBegan.resolve();
        return result;
      });
      const reports = captureShutdownReports();
      const stallWindow = Math.min(outerBudget, innerBudget);
      const outerFirst = outerBudget < innerBudget;
      expect(outerBudget).not.toBe(innerBudget);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const destroyed = booted.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      await flushBegan.promise;
      expect([...hp.documents.keys()].sort()).toEqual([...names].sort());
      const retirementsAtFlush = retirements.length;
      await vi.advanceTimersByTimeAsync(stallWindow);
      if (outerFirst) {
        expect(reports.outer()).toHaveLength(1);
        expect(reports.inner()).toEqual([]);
      } else {
        expect(reports.inner()).toHaveLength(1);
        expect(reports.outer()).toEqual([]);
      }
      expect(await reports.firstReport).toBe(outerFirst ? 'outer' : 'inner');
      const result = await destroyed;
      const loadedBeforeRelease = names.filter((name) => hp.documents.has(name));
      expect(loadedBeforeRelease).toEqual(names);
      expect(observations).toEqual([]);
      expect(retirements.slice(retirementsAtFlush)).toEqual([]);
      if (outerFirst) {
        expect(reports.outer()).toHaveLength(1);
        expect(reports.inner()).toEqual([]);
        expect(result).toEqual({ status: 'rejected', error: expect.any(AggregateError) });
        expect(result).toMatchObject({
          error: {
            errors: [
              expect.objectContaining({
                message: `destroyHocuspocus timed out: no document retired for ${outerBudget}ms`,
              }),
            ],
          },
        });
        acknowledgeBootRejection();
      } else {
        expect(reports.outer()).toEqual([]);
        expect(reports.inner()).toHaveLength(1);
        expect(reports.inner()[0]?.[0]).toMatchObject({
          err: expect.objectContaining({
            message: expect.stringContaining('3/3 docs did not unload: [first, second, third]'),
          }),
        });
        expect(reports.inner()[0]?.[0]).toMatchObject({
          err: expect.objectContaining({
            message: expect.stringContaining('rescued [first, second, third]'),
          }),
        });
        expect(result).toEqual({ status: 'fulfilled' });
      }
      for (const name of names) {
        gates.get(name)?.resolve();
        await unloaded.get(name)?.promise;
      }
      vi.useRealTimers();
      await booted.serverInstance.destroy();
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2, 1, 0]);
      expect(blockedSignalRequests).toEqual([]);
    },
  );
});

test('destroy bounds a stall after a real document unload', async () => {
  await withLoadedDocuments(
    async ({
      booted,
      gates,
      entered,
      unloaded,
      observations,
      retirements,
      acknowledgeBootRejection,
      blockedSignalRequests,
    }) => {
      const hp = booted.serverInstance.hocuspocus;
      const flushBegan = Promise.withResolvers<void>();
      const flushPendingStores = hp.flushPendingStores.bind(hp);
      vi.spyOn(hp, 'flushPendingStores').mockImplementation(() => {
        const result = flushPendingStores();
        flushBegan.resolve();
        return result;
      });
      const reports = captureShutdownReports();
      const stallWindow = Math.min(outerBudget, innerBudget);
      const outerFirst = outerBudget < innerBudget;
      expect(outerBudget).not.toBe(innerBudget);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let settled = false;
      const destroyed = booted.destroy().then(
        () => {
          settled = true;
          return { status: 'fulfilled' as const };
        },
        (error: unknown) => {
          settled = true;
          return { status: 'rejected' as const, error };
        },
      );
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      await flushBegan.promise;
      expect([...hp.documents.keys()].sort()).toEqual([...names].sort());
      const retirementsAtFlush = retirements.length;
      await vi.advanceTimersByTimeAsync(stallWindow * 0.4);
      gates.get('first')?.resolve();
      await unloaded.get('first')?.promise;
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2]);
      expect(retirements.slice(retirementsAtFlush)).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(stallWindow * 0.8);
      expect(settled).toBe(false);
      expect(reports.outer()).toEqual([]);
      expect(reports.inner()).toEqual([]);
      expect(blockedSignalRequests).toEqual([]);
      expect(names.filter((name) => hp.documents.has(name))).toEqual(['second', 'third']);
      expect(retirements.slice(retirementsAtFlush)).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(stallWindow * 0.2);
      if (outerFirst) {
        expect(reports.outer()).toHaveLength(1);
        expect(reports.inner()).toEqual([]);
      } else {
        expect(reports.inner()).toHaveLength(1);
        expect(reports.outer()).toEqual([]);
      }
      expect(await reports.firstReport).toBe(outerFirst ? 'outer' : 'inner');
      const result = await destroyed;
      if (outerFirst) {
        expect(reports.outer()).toHaveLength(1);
        expect(reports.inner()).toEqual([]);
        expect(result).toEqual({ status: 'rejected', error: expect.any(AggregateError) });
        expect(result).toMatchObject({
          error: {
            errors: [
              expect.objectContaining({
                message: `destroyHocuspocus timed out: no document retired for ${outerBudget}ms`,
              }),
            ],
          },
        });
        acknowledgeBootRejection();
      } else {
        expect(reports.outer()).toEqual([]);
        expect(reports.inner()).toHaveLength(1);
        expect(reports.inner()[0]?.[0]).toMatchObject({
          err: expect.objectContaining({
            message: expect.stringContaining('2/3 docs did not unload: [second, third]'),
          }),
        });
        expect(reports.inner()[0]?.[0]).toMatchObject({
          err: expect.objectContaining({
            message: expect.stringContaining('rescued [second, third]'),
          }),
        });
        expect(result).toEqual({ status: 'fulfilled' });
      }
      for (const name of ['second', 'third']) {
        gates.get(name)?.resolve();
        await unloaded.get(name)?.promise;
      }
      vi.useRealTimers();
      await booted.serverInstance.destroy();
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2, 1, 0]);
      expect(blockedSignalRequests).toEqual([]);
    },
  );
});

test('factory shutdown does not report continuing real unloads as a flush timeout', async () => {
  await withLoadedDocuments(
    async ({ booted, gates, entered, unloaded, observations, blockedSignalRequests }) => {
      const hp = booted.serverInstance.hocuspocus;
      const flushBegan = Promise.withResolvers<void>();
      const flushPendingStores = hp.flushPendingStores.bind(hp);
      vi.spyOn(hp, 'flushPendingStores').mockImplementation(() => {
        const result = flushPendingStores();
        flushBegan.resolve();
        return result;
      });
      const errors = vi.spyOn(getLogger('server'), 'error');
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
      const destroyed = booted.serverInstance.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      await flushBegan.promise;
      for (const name of names) {
        await vi.advanceTimersByTimeAsync(innerBudget * 0.4);
        gates.get(name)?.resolve();
        await unloaded.get(name)?.promise;
      }
      vi.useRealTimers();
      const result = await destroyed;
      await booted.serverInstance.destroy();
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2, 1, 0]);
      expect(blockedSignalRequests).toEqual([]);
      expect(result).toEqual({ status: 'fulfilled' });
      expect(flushTimeoutReports()).toEqual([]);
    },
  );
});

test('factory shutdown bounds a stall after a real document unload', async () => {
  await withLoadedDocuments(
    async ({ booted, gates, entered, unloaded, observations, blockedSignalRequests }) => {
      const hp = booted.serverInstance.hocuspocus;
      const flushBegan = Promise.withResolvers<void>();
      const flushPendingStores = hp.flushPendingStores.bind(hp);
      vi.spyOn(hp, 'flushPendingStores').mockImplementation(() => {
        const result = flushPendingStores();
        flushBegan.resolve();
        return result;
      });
      const errors = vi.spyOn(getLogger('server'), 'error');
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
      const destroyed = booted.serverInstance.destroy().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      await flushBegan.promise;
      await vi.advanceTimersByTimeAsync(innerBudget * 0.4);
      gates.get('first')?.resolve();
      await unloaded.get('first')?.promise;
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2]);
      await vi.advanceTimersByTimeAsync(innerBudget * 0.8);
      expect(flushTimeoutReports()).toEqual([]);
      expect(blockedSignalRequests).toEqual([]);
      expect(names.filter((name) => hp.documents.has(name))).toEqual(['second', 'third']);
      await vi.advanceTimersByTimeAsync(innerBudget * 0.2);
      expect(flushTimeoutReports()).toHaveLength(1);
      for (const name of ['second', 'third']) {
        gates.get(name)?.resolve();
        await unloaded.get(name)?.promise;
      }
      vi.useRealTimers();
      const result = await destroyed;
      expect(result).toEqual({ status: 'fulfilled' });
      expect(observations.map((entry) => entry.loaded.length)).toEqual([2, 1, 0]);
      expect(blockedSignalRequests).toEqual([]);
    },
  );
});
