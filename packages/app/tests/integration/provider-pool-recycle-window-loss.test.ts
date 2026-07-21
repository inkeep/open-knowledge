import './idb-preload';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, pollUntil, seedPoolServerInstanceId } from './test-harness';

/**
 * Disconnect-recycle window vs local edits.
 *
 * `onDisconnect` (provider-pool.ts) checks `provider.unsyncedChanges === 0`
 * when ARMING the debounced recycle timer AND re-checks it inside the timer
 * closure at FIRE time. The fire-time re-check is load-bearing: an edit
 * typed inside the debounce window makes the doc dirty, and the plain
 * recycle path has no buffer-and-replay (that exists only for
 * `server-instance-mismatch`) — without the re-check, the recycle destroys
 * the edit permanently whenever the server identity changes before resync.
 *
 * Pinned contract: a dirty entry is never torn down by the plain recycle;
 * the edit survives both identity-changed reconnects (via the mismatch
 * path's buffer-and-replay) and identity-stable offline windows (edit stays
 * live in the un-recycled doc), and a clean entry still recycles normally.
 */

const SEED = `# Seed

Adeline: 1652

## TODO

- item one
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('disconnect-recycle window vs local edit', () => {
  test('an edit typed during the armed recycle-debounce window survives the recycle', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      // Short debounce so the window is testable; production is 4000ms.
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    // Disconnect with a clean provider — the recycle timer arms because
    // `unsyncedChanges === 0` holds NOW.
    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    // Type INSIDE the armed window (before the 250ms timer fires). This is
    // the customer motion: window blur drops the socket, the user types on
    // return before the (background-clamped) timer has fired.
    const MARKER = 'RW-LOCAL-EDIT-MARKER-c41d';
    const doc = firstProvider.document;
    const paragraph = new Y.XmlElement('paragraph');
    const xtext = new Y.XmlText();
    xtext.applyDelta([{ insert: MARKER }]);
    paragraph.insert(0, [xtext]);
    doc.getXmlFragment('default').push([paragraph]);
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    // Let the armed timer fire.
    await wait(700);
    const recycled = pool.getActive()?.provider !== firstProvider;

    // Bring the server back on the same port and let the pool re-sync.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    // Allow any deferred persistence hydration / replay to land.
    await wait(1_000);

    const finalText =
      pool.getActive()?.provider.document.getXmlFragment('default').toString() ?? '';
    const finalSource = pool.getActive()?.provider.document.getText('source').toString() ?? '';

    // Diagnostic context on failure.
    console.info(
      JSON.stringify({
        event: 'recycle-window-loss-diagnostic',
        recycled,
        markerInFragment: finalText.includes(MARKER),
        markerInSource: finalSource.includes(MARKER),
      }),
    );

    // Correct behavior: the local edit survives the disconnect + recycle.
    expect(finalText.includes(MARKER) || finalSource.includes(MARKER)).toBe(true);
    // No double-apply: the marker lands at most once per CRDT surface even
    // though IDB rehydration and mismatch buffer-and-replay both ran.
    expect(finalText.split(MARKER).length - 1).toBeLessThanOrEqual(1);
    expect(finalSource.split(MARKER).length - 1).toBeLessThanOrEqual(1);
  }, 40_000);

  /**
   * Same identity-changed motion, source-mode surface: the unsynced edit
   * lives in Y.Text (W2) instead of the XmlFragment. Pins the symmetric
   * branch of the content-level replay (fragment is the clean base, Y.Text
   * carries the edit).
   *
   */
  test('a source-mode edit typed during the window survives a server-identity change', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-src-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    const MARKER = 'RW-SOURCE-EDIT-MARKER-9a3b';
    const ytext = firstProvider.document.getText('source');
    firstProvider.document.transact(() => {
      ytext.insert(ytext.length, `\n${MARKER}\n`);
    });
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    await wait(700);

    server = await server.killAndRestartOnSamePort({ downtimeMs: 300 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await wait(1_000);

    const finalSource = pool.getActive()?.provider.document.getText('source').toString() ?? '';
    expect(finalSource.includes(MARKER)).toBe(true);
    expect(finalSource.split(MARKER).length - 1).toBe(1);
  }, 40_000);

  /**
   * Identity-stable offline window: the server never comes back during the
   * test. The fire-time guard must SKIP the recycle while the doc holds an
   * unsynced edit — the entry stays pooled and the edit stays live in the
   * original Y.Doc, ready to sync on a same-identity reconnect (the customer
   * case where their local server never restarted).
   *
   */
  test('a dirty entry is not recycled when the debounce window elapses offline', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-dirty-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    const MARKER = 'RW-DIRTY-EDIT-MARKER-77e2';
    const doc = firstProvider.document;
    const paragraph = new Y.XmlElement('paragraph');
    const xtext = new Y.XmlText();
    xtext.applyDelta([{ insert: MARKER }]);
    paragraph.insert(0, [xtext]);
    doc.getXmlFragment('default').push([paragraph]);
    expect(firstProvider.unsyncedChanges).toBeGreaterThan(0);

    // Let the armed timer fire well past the 250ms debounce.
    await wait(700);

    // The fire-time guard skipped the recycle: same provider, edit live.
    expect(pool.getActive()?.provider).toBe(firstProvider);
    expect(firstProvider.document.getXmlFragment('default').toString().includes(MARKER)).toBe(true);
  }, 40_000);

  /**
   * Resource reclamation is unchanged for clean entries: with no unsynced
   * edits, the debounced recycle still tears down and re-opens the entry
   * after the window elapses.
   *
   */
  test('a clean entry still recycles after the debounce window elapses', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = `recycle-window-clean-${crypto.randomUUID()}`;
    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`, {
      recycleDebounceMs: 250,
    });
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    writeFileSync(join(server.contentDir, `${docName}.md`), SEED, 'utf-8');
    pool.open(docName);
    pool.setActive(docName);
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    const firstProvider = pool.getActive()?.provider;
    if (!firstProvider) throw new Error('no active provider after seed');

    server.killNetwork();
    await pollUntil(() => pool.getActive()?.syncState === 'disconnected', 5_000, 20);

    // No local edit — the entry is clean, so the timer should recycle it.
    await pollUntil(() => pool.getActive()?.provider !== firstProvider, 5_000, 20);
    expect(pool.getActive()?.provider).not.toBe(firstProvider);
  }, 40_000);
});
