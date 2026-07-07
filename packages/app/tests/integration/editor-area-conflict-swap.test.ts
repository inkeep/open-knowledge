/**
 * Editor-area conflict swap — integration coverage for the lifecycle
 * gate propagation that drives the React conditional render in
 * EditorActivityPool's ActivityEntry.
 *
 * These tests exercise the server-observable contract beneath the React
 * conditional:
 *   - Gate set: server-side `lifecycle.status='conflict'` is observed by
 *     the connected client via Y.Doc sync (the React `useLifecycleStatus`
 *     hook reads exactly this value).
 *   - Gate clear: clearing the lifecycle key propagates back to the
 *     client; Y.Text identity + content survive the round-trip.
 *
 * The DOM-level swap behavior is covered by `DiffViewBoundary.dom.test.tsx`
 * and `use-lifecycle-status.dom.test.tsx`. The "Keep mine" dispatch shape
 * is asserted in the DiffViewBoundary DOM test (it pins the POST body).
 * A full round-trip — content lands on disk via the resolve-conflict
 * endpoint — requires a real `git merge` in progress and is covered by the
 * sync-engine boundary tests, not here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';
const CONFLICT_MARKERS =
  '<<<<<<< HEAD\n# Mine\n\nLocal version.\n=======\n# Theirs\n\nTeam version.\n>>>>>>> origin/main\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function setupServerWithDoc(docName: string, initial: string): Promise<TestServer> {
  const server = await createTestServer({ debounce: 100, maxDebounce: 500 });
  cleanups.push(() => server.cleanup());
  writeFileSync(join(server.contentDir, `${docName}.md`), initial, 'utf-8');
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (!res?.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) ?? false;
  });
  return server;
}

describe('editor-area swap — gate propagation', () => {
  /**
   * When the server sets `lifecycle.status='conflict'`, the connected
   * client observes the change via Y.Map sync — this is the gate value the
   * React `useLifecycleStatus` hook reads to drive the conditional render.
   *
   * When the server clears `lifecycle.status`, the client also sees the
   * deletion via sync, and the underlying Y.Text reference is the same
   * object identity (no destroy/recreate of Y.Text across the lifecycle
   * change).
   *
   */
  test('lifecycle.status conflict → clear round-trip preserves Y.Text identity', async () => {
    const docName = `swap-roundtrip-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const ytextRefBefore = client.ytext;
    const lifecycle = client.doc.getMap('lifecycle');

    // Drive lifecycle='conflict' via the realistic source — file-watcher
    // detecting conflict markers on disk. case 'conflict' sets the gate.
    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // gate is set on the client side — `useLifecycleStatus(docName)`
    // would return 'conflict' and the UI would mount DiffViewBoundary.
    expect(lifecycle.get('status')).toBe('conflict');

    // clear the gate on the server (mirrors what `case 'update'`
    // clean/merged/noop branches do post-resolution, or what an admin
    // recovery procedure does manually).
    const serverDoc = server.instance.hocuspocus.documents.get(docName);
    expect(serverDoc).toBeTruthy();
    serverDoc?.transact(() => {
      serverDoc.getMap('lifecycle').delete('status');
      serverDoc.getMap('lifecycle').delete('reason');
    });

    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('status')).toBeUndefined();

    // Y.Text reference is unchanged across the lifecycle round-trip. The
    // Y.Doc never destroys/recreates; the editor remount that follows the
    // conditional re-render binds to the SAME Y.Text (so content + scroll
    // position + undo history survive across the swap).
    expect(client.ytext).toBe(ytextRefBefore);
    expect(client.ytext).toBe(client.doc.getText('source'));
  }, 30_000);
});
