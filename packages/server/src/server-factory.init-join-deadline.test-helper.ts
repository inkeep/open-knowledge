import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as parcel from '@parcel/watcher';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import type { NativeWatcherBackend } from './parcel-subscription.ts';
import type { ServerInstance } from './server-factory.ts';

interface Operation {
  id: number;
  kind: 'subscribe' | 'unsubscribe';
  directory: string;
  completed: boolean;
}

interface NativeRecord {
  directory: string;
  subscription: parcel.AsyncSubscription;
  releaseCalls: number;
  released: boolean;
}

export type WatcherTarget = 'content' | 'head';

export const RESULT_PREFIX = 'FACTORY_NATIVE_RESULT ';
export const READY_LINE = 'FACTORY_NATIVE_READY';

async function factoryProbe(root: string, expireInit: boolean, target: WatcherTarget) {
  const runRoot = dirname(root);
  const project = join(root, 'project');
  const gitDirectory = join(project, '.git');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  const environmentKeys = new Set([
    'HOME',
    'USERPROFILE',
    'OK_FILE_WATCHER_BACKEND',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    ...Object.keys(process.env).filter((key) => key.startsWith('GIT_')),
  ]);
  const environment = new Map([...environmentKeys].map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    const { createServer } = await import('./server-factory.ts');
    const { getLogger } = await import('./logger.ts');
    const parcel = await import('@parcel/watcher');
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', '--template='], {
      cwd: project,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    configureTestGitRepository(project);
    mkdirSync(join(project, '.ok'));
    writeFileSync(join(project, '.ok', 'config.yml'), '');
    writeFileSync(join(project, 'start.md'), '# Start\n');

    const operations: Operation[] = [];
    const nativeRecords: NativeRecord[] = [];
    const events: Array<Record<string, unknown>> = [];
    let callingNative: { kind: Operation['kind']; directory: string } | undefined;
    const hook = createHook({
      init(id, type) {
        if (type !== 'undefined' || callingNative === undefined) return;
        operations.push({ id, ...callingNative, completed: false });
        events.push({ event: 'native-queued', id, ...callingNative });
      },
      before(id) {
        const operation = operations.find((entry) => entry.id === id);
        if (operation === undefined) return;
        operation.completed = true;
        events.push({ event: 'native-completion-entered', id });
      },
    }).enable();
    const pending = () => operations.filter((entry) => !entry.completed).map((entry) => entry.id);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    let teardownStarted = false;
    let initExpired = false;
    globalThis.setTimeout = Object.assign(
      <T extends unknown[]>(callback: (...args: T) => void, delay?: number, ...args: T) => {
        const handle = realSetTimeout(callback, delay, ...args);
        timers.add(handle);
        const stack = new Error('deadline site').stack ?? '';
        if (
          expireInit &&
          teardownStarted &&
          !initExpired &&
          stack.includes('/server-factory.ts:') &&
          !stack.includes('joinPrelude')
        ) {
          initExpired = true;
          clearTimeout(handle);
          events.push({ event: 'deadline-selected', delay, stack, pending: pending() });
          queueMicrotask(() => {
            events.push({ event: 'deadline-fired', pending: pending() });
            callback(...args);
          });
        }
        return handle;
      },
      realSetTimeout,
    );
    globalThis.setInterval = Object.assign(
      <T extends unknown[]>(callback: (...args: T) => void, delay?: number, ...args: T) => {
        const handle = realSetInterval(callback, delay, ...args);
        timers.add(handle);
        return handle;
      },
      realSetInterval,
    );
    const logger = getLogger('server');
    const warn = logger.warn;
    logger.warn = (fields, message) => {
      if (message === '[server] init did not complete before the pre-flush deadline') {
        events.push({ event: 'initialization-drain-timeout', pending: pending() });
      }
      return warn.call(logger, fields, message);
    };

    let server: ServerInstance | undefined;
    const destruction = Promise.withResolvers<void>();
    let destroyPromise: Promise<void> | undefined;
    let pendingAtStart: number[] = [];
    const backend: NativeWatcherBackend = {
      async subscribe(directory, callback, options) {
        callingNative = { kind: 'subscribe', directory };
        const acquisition = parcel.subscribe(directory, callback, options);
        void acquisition.catch((error: unknown) => {
          events.push({ event: 'native-acquisition-failed', directory, error: String(error) });
        });
        callingNative = undefined;
        const targetDirectory = target === 'head' ? gitDirectory : project;
        if (expireInit && directory === targetDirectory && destroyPromise === undefined) {
          const activeServer = server;
          if (activeServer === undefined)
            throw new Error('Factory was not returned before subscription');
          pendingAtStart = pending();
          teardownStarted = true;
          events.push({ event: 'destroy-entered', directory, pending: pendingAtStart });
          destroyPromise = activeServer.destroy();
          void destroyPromise.then(destruction.resolve, destruction.reject);
        }
        const subscription = await acquisition;
        const record: NativeRecord = { directory, subscription, releaseCalls: 0, released: false };
        nativeRecords.push(record);
        events.push({ event: 'subscription-returned', directory });
        return {
          async unsubscribe() {
            record.releaseCalls++;
            callingNative = { kind: 'unsubscribe', directory };
            const release = subscription.unsubscribe();
            callingNative = undefined;
            await release;
            record.released = true;
          },
        };
      },
    };

    console.log(READY_LINE);
    try {
      server = createServer({
        contentDir: project,
        projectDir: project,
        configHomedirOverride: home,
        authorityRegistryPath: join(root, 'authority.sqlite'),
        watcherBackend: backend,
        freshnessIntervalMs: null,
        gitEnabled: false,
        quiet: true,
      });
      const readiness = server.ready.then(
        () => ({ status: 'fulfilled' }),
        (error: unknown) => ({ status: 'rejected', error: String(error) }),
      );
      if (expireInit) {
        await destruction.promise;
        events.push({ event: 'destroy-settled', pending: pending() });
      } else {
        await readiness;
        await server.destroy();
      }
      const ready = await readiness;
      await server.destroy();
      const result = {
        mode: expireInit ? 'expired-init' : 'control',
        target,
        pendingAtStart,
        ready,
        operations,
        subscriptions: nativeRecords.map(({ directory, releaseCalls, released }) => ({
          directory,
          releaseCalls,
          released,
        })),
        events,
      };
      writeFileSync(
        join(runRoot, `factory-${result.mode}-${target}.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(RESULT_PREFIX + JSON.stringify(result));
      assertFactoryResult(result, project, expireInit, target);
      return result;
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
      logger.warn = warn;
      for (const handle of timers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      for (const record of nativeRecords) {
        if (!record.released) {
          await record.subscription.unsubscribe();
          record.released = true;
        }
      }
      if (server !== undefined) {
        await server.syncEngine?.destroy();
        await server.destroy();
      }
      hook.disable();
    }
  } finally {
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export type FactoryProbeResult = Awaited<ReturnType<typeof factoryProbe>>;

export function assertFactoryResult(
  result: FactoryProbeResult,
  project: string,
  expireInit: boolean,
  target: WatcherTarget,
): void {
  const { operations, pendingAtStart, subscriptions, events, ready } = result;
  const gitDirectory = join(project, '.git');
  assert.equal(result.mode, expireInit ? 'expired-init' : 'control');
  assert.equal(result.target, target);
  assert.equal(
    operations.some((entry) => entry.kind === 'subscribe'),
    true,
  );
  if (expireInit) {
    assert.ok(pendingAtStart.length > 0);
    const entered = events.find((entry) => entry.event === 'destroy-entered');
    assert.ok(entered, 'shutdown begins from the targeted real subscription');
    assert.equal(entered.directory, target === 'head' ? gitDirectory : project);
    assert.ok(Array.isArray(entered.pending));
    for (const id of pendingAtStart) assert.ok(entered.pending.includes(id));
    assert.equal(
      subscriptions.some(
        (entry) => entry.directory === (target === 'head' ? gitDirectory : project),
      ),
      true,
    );
    const deadline = events.find((entry) => entry.event === 'initialization-drain-timeout');
    assert.ok(deadline);
    assert.ok(Array.isArray(deadline.pending));
    for (const id of pendingAtStart) assert.ok(deadline.pending.includes(id));
  } else {
    assert.deepEqual(
      subscriptions.map((entry) => entry.directory).sort(),
      [project, gitDirectory].sort(),
      'the completed startup control acquires both real Parcel subscriptions',
    );
    assert.equal(ready.status, 'fulfilled');
  }
  assert.deepEqual(
    subscriptions.filter((entry) => !entry.released).map((entry) => entry.directory),
    [],
    'every real native subscription is released by factory shutdown',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [root, name] = process.argv.slice(2);
  assert.ok(root);
  switch (name) {
    case 'factory control releases real native subscriptions after initialization':
      await factoryProbe(root, false, 'content');
      break;
    case 'factory releases a native acquisition crossing the initialization deadline':
      await factoryProbe(root, true, 'content');
      break;
    case 'factory releases a HEAD acquisition crossing the initialization deadline':
      await factoryProbe(root, true, 'head');
      break;
    default:
      throw new Error('Unknown factory probe case');
  }
}
