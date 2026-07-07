/**
 * Server lifetime follows connected WebSocket clients, not the process that
 * launched the server. One remaining sibling client keeps the lock
 * alive past the idle window; after the last client disconnects, idle-shutdown
 * releases the lock.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import {
  type BootedServer,
  bootServer,
  ConfigSchema,
  ensureProjectGit,
} from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { waitForSync } from './test-harness.ts';

const IDLE_SHUTDOWN_MS = 400;
const WS_CLOSE_SETTLE_MS = 150;

let booted: BootedServer | null = null;
let contentDir = '';
let lockPath = '';

beforeAll(async () => {
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-idle-multi-')));
  await ensureProjectGit(contentDir);
  // Pre-listen check needs <contentDir>/.ok/config.yml present.
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
    attachUiSibling: false,
    idleShutdownMs: IDLE_SHUTDOWN_MS,
  });
  lockPath = resolve(contentDir, OK_DIR, LOCAL_DIR, 'server.lock');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  // Idempotent — idle-shutdown now runs the full destroy() chain, so the
  // httpServer + telemetry will already be torn down by the time we get here.
  // The call below is a safety net for failure paths that exit before idle.
  await booted?.destroy();
  rmSync(contentDir, { recursive: true, force: true });
});

test('closing spawning editor leaves sibling editor connected; idle-shutdown fires only when both disconnect', async () => {
  const server = booted;
  if (server === null) {
    throw new Error('bootServer did not initialize');
  }
  const port = server.port;

  // Both clients connect before the initial scheduleShutdown timer fires.
  const docA = `idle-multi-a-${crypto.randomUUID()}`;
  const docB = `idle-multi-b-${crypto.randomUUID()}`;
  const yDocA = new Y.Doc();
  const yDocB = new Y.Doc();
  const providerA = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docA,
    document: yDocA,
    connect: true,
  });
  const providerB = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docB,
    document: yDocB,
    connect: true,
  });

  await waitForSync(providerA);
  await waitForSync(providerB);

  expect(existsSync(lockPath)).toBe(true);

  // Editor A disconnects (the editor that originally spawned `ok start`).
  // Let the WebSocket close event reach the server-side idle counter before
  // checking that the sibling keeps the lock alive.
  providerA.destroy();
  yDocA.destroy();
  await wait(WS_CLOSE_SETTLE_MS);

  // Server stays alive past the idle threshold because B is still connected.
  await wait(IDLE_SHUTDOWN_MS + 200);
  expect(existsSync(lockPath)).toBe(true);
  expect(providerB.isSynced).toBe(true);

  // Now editor B disconnects — counter goes to zero, idle-shutdown schedules,
  // and the server tears down within the configured window.
  providerB.destroy();
  yDocB.destroy();

  const deadline = Date.now() + 5_000;
  while (existsSync(lockPath) && Date.now() < deadline) {
    await wait(25);
  }
  expect(existsSync(lockPath)).toBe(false);

  // Regression guard: idle-shutdown must run the FULL destroy chain, not just
  // destroyHocuspocus(). Pre-fix, the lock file release above passed (Hocuspocus
  // releases it directly) while httpServer.listening stayed true, leaving a
  // zombie listener that survived for the lifetime of the parent process.
  // `boot.ts`'s destroy() runs httpServer.close() before destroyHocuspocus(),
  // so by the time the lock is gone the listener is gone too — no extra wait
  // needed. boot.test.ts has a faster spot-test for this but is skipped on CI
  // (oven-sh/bun#11892); this assertion is the CI-side guard.
  expect(server.httpServer.listening).toBe(false);
});
