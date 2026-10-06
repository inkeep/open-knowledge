import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { defaultScheduler, LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  bootServer,
  ConfigSchema,
  ensureProjectGit,
} from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, expect, onTestFinished, test, vi } from 'vitest';
import * as Y from 'yjs';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import * as idleShutdown from '../../../server/src/idle-shutdown.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { waitForSync } from './test-harness.ts';

const fixtureHome = vi.hoisted(() => ({ path: '' }));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixtureHome.path,
}));

const IDLE_SHUTDOWN_MS = 400;
const WS_CLOSE_SETTLE_MS = 150;

let booted: BootedServer | null = null;
let contentDir = '';
let lockPath = '';
let idleShutdownPromise: Promise<void> | undefined;
const clientsSynced = Promise.withResolvers<void>();

beforeAll(async () => {
  fixtureHome.path = realpathSync(mkdtempSync(join(tmpdir(), 'ok-idle-home-')));
  const attachIdleShutdown = idleShutdown.attachIdleShutdown;
  const attachSpy = vi.spyOn(idleShutdown, 'attachIdleShutdown').mockImplementation((options) =>
    attachIdleShutdown({
      ...options,
      scheduler: {
        ...defaultScheduler,
        setTimeout: (callback, ms) =>
          defaultScheduler.setTimeout(() => {
            void clientsSynced.promise.then(callback);
          }, ms),
      },
    }),
  );
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-idle-multi-')));
  await ensureProjectGit(contentDir);
  configureTestGitRepository(contentDir);
  const okDir = join(contentDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(join(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(join(okDir, '.gitignore'), '', 'utf-8');
  booted = await bootServer({
    host: '127.0.0.1',
    config: ConfigSchema.parse({}),
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    skipAutoInit: true,
    configHomedirOverride: fixtureHome.path,
    idleShutdownMs: IDLE_SHUTDOWN_MS,
    idleShutdownHandler: (destroyServer) => () => {
      idleShutdownPromise = destroyServer();
      return idleShutdownPromise;
    },
  });
  expect(attachSpy).toHaveBeenCalledOnce();
  lockPath = resolve(contentDir, OK_DIR, LOCAL_DIR, 'server.lock');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await booted?.destroy();
    await idleShutdownPromise;
  } finally {
    vi.restoreAllMocks();
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(fixtureHome.path, { recursive: true, force: true });
  }
});

test('closing spawning editor leaves sibling editor connected; idle-shutdown fires only when both disconnect', async () => {
  const server = booted;
  if (server === null) {
    throw new Error('bootServer did not initialize');
  }
  const port = server.port;

  const docA = `idle-multi-a-${crypto.randomUUID()}`;
  const docB = `idle-multi-b-${crypto.randomUUID()}`;
  const yDocA = new Y.Doc();
  const yDocB = new Y.Doc();
  const providerA = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docA,
    document: yDocA,
    autoConnect: true,
  });
  onTestFinished(() => {
    if (!yDocA.isDestroyed) {
      providerA.destroy();
      yDocA.destroy();
    }
  });
  const providerB = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docB,
    document: yDocB,
    autoConnect: true,
  });
  onTestFinished(() => {
    if (!yDocB.isDestroyed) {
      providerB.destroy();
      yDocB.destroy();
    }
  });

  await expect(waitForSync(providerA)).resolves.toBeUndefined();
  await expect(waitForSync(providerB)).resolves.toBeUndefined();
  clientsSynced.resolve();

  expect(existsSync(lockPath)).toBe(true);

  providerA.destroy();
  yDocA.destroy();
  await wait(WS_CLOSE_SETTLE_MS);

  await wait(IDLE_SHUTDOWN_MS + 200);
  expect(existsSync(lockPath)).toBe(true);
  expect(providerB.isSynced).toBe(true);

  providerB.destroy();
  yDocB.destroy();

  const readDraining = (): boolean => {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as { draining?: boolean };
      return parsed.draining === true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5_000;
  while (!readDraining() && Date.now() < deadline) {
    await wait(25);
  }
  expect(readDraining()).toBe(true);

  const listenDeadline = Date.now() + 5_000;
  while (server.httpServer.listening && Date.now() < listenDeadline) {
    await wait(25);
  }
  expect(server.httpServer.listening).toBe(false);
});
