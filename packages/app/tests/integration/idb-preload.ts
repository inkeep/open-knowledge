import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

// Global afterEach hook: wipe every `ok-ydoc:` IDB database after each
// test. fake-indexeddb persists state across tests within a single Vitest
// worker process, so tests that share doc names (e.g., the common 'test-doc'
// harness name) would otherwise hydrate from prior-test state on open.
// Cleaning here prevents cross-test pollution WITHOUT requiring every
// integration test to call resetFakeIndexedDB explicitly.
//
// This relies on Vitest running afterEach hooks in LIFO order: per-file teardown
// hooks registered after this preload close providers/servers first, then this
// hook deletes the databases. Under FIFO ordering,
// deleteDatabase would hit onblocked while provider IDB handles are still open.
afterEach(async () => {
  if (typeof indexedDB === 'undefined') return;
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs.map((info) => {
      if (info.name === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(info.name as string);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }),
  );
});
