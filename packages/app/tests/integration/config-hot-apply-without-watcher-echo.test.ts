/**
 * Contract: a config change the server itself validates and persists on the
 * client Y.Doc path (ConfigBinding.patch → Hocuspocus → storeConfigDoc) must
 * reach the server's live in-process consumers EVEN IF the chokidar watcher
 * echo of the server's own write never delivers.
 *
 * Before the producer-side `onConfigPersisted` notification existed, the ONLY
 * path that applied a persisted config change to the sync engine and the
 * semantic-search service was the config-file-watcher callback in
 * server-factory.ts — a filesystem round-trip through a polling chokidar watch.
 * That echo channel is non-guaranteed (documented drops under load; a 10s boot
 * fallback poll is the only backstop), so a missed echo left the persisted
 * value unapplied until restart: disk said enabled, engine / semantic service
 * stayed disabled — observed in the field on Windows 11. These tests pin the
 * producer-side guarantee that closes that gap.
 *
 * Fault injection is at the OS filesystem-watcher boundary ONLY: chokidar is
 * mocked to emit `ready` then swallow every event, simulating an undelivered
 * echo. Everything else is real — real server, real WebSocket, real
 * ConfigBinding.patch, real atomic config persistence, real sync engine, real
 * semantic-search service, real HTTP API. The assertions are on observable
 * consumer state (engine `syncEnabled`; `GET /api/semantic-status` `enabled`),
 * not on how the notification is delivered.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Register BEFORE the server's dynamic `await import('chokidar')` runs. The
// watcher fires `ready` (chokidar's post-initial-scan signal) then swallows
// every subsequent add/change event — the undelivered-echo condition the fix
// must survive.
class SwallowingWatcher extends EventEmitter {
  constructor() {
    super();
    setTimeout(() => this.emit('ready'), 10);
  }
  add(): this {
    return this;
  }
  unwatch(): this {
    return this;
  }
  async close(): Promise<void> {}
}
// `mock.module` replaces chokidar for the WHOLE bun-test process, not just this
// file — sibling test files in the same shard would inherit the swallowed
// watcher and silently starve on filesystem events (observed: managed-artifact
// reconcile timing out in the same shard). Confine the fault injection to this
// file: swallow only while this file's suites run, then delegate to the real
// implementation.
//
// The delegation target MUST be a destructured function reference captured
// BEFORE mock.module runs: when the module was already imported earlier in the
// process, bun patches the existing namespace's live bindings, so delegating
// through a captured namespace object would call the mock itself (infinite
// recursion). A destructured const keeps pointing at the real function.
const { watch: realChokidarWatch } = await import('chokidar');
let swallowChokidarEvents = true;
afterAll(() => {
  swallowChokidarEvents = false;
});
mock.module('chokidar', () => ({
  watch: (...args: Parameters<typeof realChokidarWatch>) =>
    swallowChokidarEvents
      ? (new SwallowingWatcher() as unknown as ReturnType<typeof realChokidarWatch>)
      : realChokidarWatch(...args),
}));

import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  type ConfigBinding,
} from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { createTestServer, pollUntil, type TestServer, wait } from './test-harness';

// The config-file-watcher's fallback poll (server-factory / config-file-watcher)
// calls the change handler directly for ~10s after boot, bypassing chokidar. It
// would mask the swallowed echo inside that window — mirroring production, where
// a toggle minutes after boot has no such backstop. Wait it out so the patch
// lands strictly after the fallback has self-terminated: the exact real-world
// scenario this bug describes. This is a wait on a known bounded backstop, not a
// race-hiding sleep.
const FALLBACK_POLL_WINDOW_MS = 11_000;

describe('PRD-7260 — persisted config change reaches in-process consumers without the watcher echo', () => {
  let srv: TestServer;
  let ydoc: Y.Doc;
  let provider: HocuspocusProvider;
  let binding: ConfigBinding;

  beforeAll(async () => {
    srv = await createTestServer();
    // Let the boot-time fallback poll window expire so the swallowed chokidar
    // echo is the ONLY remaining propagation channel.
    await wait(FALLBACK_POLL_WINDOW_MS);

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT_LOCAL,
      document: ydoc,
      connect: true,
    });
    binding = bindConfigDoc(provider, 'project-local');
    await pollUntil(() => binding.hasSynced(), 10_000);
  }, 40_000);

  afterAll(async () => {
    binding?.dispose();
    provider?.destroy();
    ydoc?.destroy();
    await srv?.cleanup();
  });

  test(
    'sync engine hot-applies autoSync.enabled from a client patch',
    async () => {
      const configPath = join(srv.contentDir, '.ok', 'local', 'config.yml');
      expect(srv.instance.syncEngine?.getStatus().syncEnabled).toBe(false);

      const result = binding.patch({ autoSync: { enabled: true } });
      expect(result.ok).toBe(true);

      // Persistence leg is healthy on every platform — the disk reflects the
      // patch. This is the last thing that provably works today.
      await pollUntil(
        () => existsSync(configPath) && /enabled:\s*true/.test(readFileSync(configPath, 'utf-8')),
        15_000,
      );

      // Contract: the live sync engine must observe the persisted value even
      // though the watcher echo never fired.
      await pollUntil(() => srv.instance.syncEngine?.getStatus().syncEnabled === true, 15_000);
    },
    { timeout: 90_000 },
  );

  test(
    'semantic search hot-applies search.semantic.enabled from a client patch',
    async () => {
      const statusUrl = `http://127.0.0.1:${srv.port}/api/semantic-status`;

      const before = await (await fetch(statusUrl)).json();
      expect(before.enabled).toBe(false);

      const result = binding.patch({ search: { semantic: { enabled: true } } });
      expect(result.ok).toBe(true);

      // Contract: the semantic-search service must observe the persisted value
      // even though the watcher echo never fired. Observed through the existing
      // read-only /api/semantic-status surface.
      await pollUntil(async () => {
        const res = await fetch(statusUrl);
        const body = await res.json();
        return body.enabled === true;
      }, 15_000);
    },
    { timeout: 90_000 },
  );
});

/**
 * The two tests above pin the `'persisted'` success outcome of `storeConfigDoc`.
 * `storeConfigDoc` has a SECOND success outcome — `'reconciled'` — which the
 * producer-side propagation fix must also honor, and which is not exercised
 * above.
 *
 * `'reconciled'` fires when, at store time, the on-disk config file has diverged
 * from the LKG cache AND the disk content validates — i.e. an external /
 * cross-process writer landed on the shared config file while this server's
 * Y.Doc view was stale. `storeConfigDoc` then imports the DISK content into
 * Y.Text (under CONFIG_FILE_WATCHER_ORIGIN), sets LKG = disk, and returns
 * `'reconciled'` WITHOUT writing the client's value. See
 * `config-persistence.ts` storeConfigDocInner: the in-lock
 * `diskContent !== lkg` + `diskValidation.ok` branch.
 *
 * Contract this test pins: after a reconciliation triggered by a client patch,
 * the live in-process consumers must observe the RECONCILED (disk) value — the
 * exact value the (swallowed) chokidar echo would otherwise have carried. A
 * fix that fires the producer notification only on `'persisted'` and not on
 * `'reconciled'` would fail this test.
 *
 * This uses a fresh server (own contentDir) so the LKG / disk / consumer state
 * is controlled from boot and is independent of the two tests above.
 */
describe('PRD-7260 — reconciled config change reaches in-process consumers without the watcher echo', () => {
  let srv: TestServer;
  let ydoc: Y.Doc;
  let provider: HocuspocusProvider;
  let binding: ConfigBinding;

  beforeAll(async () => {
    srv = await createTestServer();
    await wait(FALLBACK_POLL_WINDOW_MS);

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT_LOCAL,
      document: ydoc,
      connect: true,
    });
    binding = bindConfigDoc(provider, 'project-local');
    await pollUntil(() => binding.hasSynced(), 10_000);
  }, 40_000);

  afterAll(async () => {
    binding?.dispose();
    provider?.destroy();
    ydoc?.destroy();
    await srv?.cleanup();
  });

  test(
    'sync engine hot-applies the reconciled (disk) autoSync.enabled after a client patch',
    async () => {
      const configPath = join(srv.contentDir, '.ok', 'local', 'config.yml');
      expect(srv.instance.syncEngine?.getStatus().syncEnabled).toBe(false);

      // An external / cross-process writer lands `autoSync.enabled: true` on the
      // shared project-local config file. With the chokidar echo swallowed the
      // server never imports it, so at the next store the on-disk content
      // diverges from LKG — the `'reconciled'` precondition.
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, 'autoSync:\n  enabled: true\n', 'utf-8');

      // Client patches the OPPOSITE value. At store time `storeConfigDoc` sees
      // disk (`true`) diverge from LKG, validates it, imports the disk content
      // into Y.Text, and returns `'reconciled'` — the client's `false` is
      // dropped in favor of the external writer's `true`.
      const result = binding.patch({ autoSync: { enabled: false } });
      expect(result.ok).toBe(true);

      // Reconciliation imports disk into Y.Text but does NOT write disk — the
      // client's `false` never reaches the file. Disk still shows the external
      // writer's `true`, proving the reconcile path (not the persist path) ran.
      await pollUntil(
        () =>
          existsSync(configPath) &&
          /enabled:\s*true/.test(readFileSync(configPath, 'utf-8')) &&
          !/enabled:\s*false/.test(readFileSync(configPath, 'utf-8')),
        15_000,
      );

      // Reconciliation imports the disk content back into Y.Text, which syncs to
      // the client — so the client's own view flips from its patched `false` to
      // the reconciled `true`. This distinguishes a genuine `'reconciled'`
      // outcome from a no-op (a no-op would leave the client at `false`), and
      // holds today, independent of the consumer-propagation fix.
      await pollUntil(() => binding.current().autoSync?.enabled === true, 15_000);

      // Contract: the live sync engine must observe the reconciled DISK value
      // (`true`) even though the watcher echo never fired.
      await pollUntil(() => srv.instance.syncEngine?.getStatus().syncEnabled === true, 15_000);
    },
    { timeout: 90_000 },
  );
});
