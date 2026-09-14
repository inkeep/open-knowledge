
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type * as Y from 'yjs';

import {
  insertLocal,
  mountCollabEditor,
  readUndoManager,
} from '../../src/editor/editor-rig.test-helper';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  agentWriteMd,
  awaitDocQuiescence,
  awaitWipCommits,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  const nodeEvent = globalThis.Event;
  const nodeCustomEvent = globalThis.CustomEvent;
  restoreDom = installDomGlobals();
  Object.defineProperty(globalThis, 'Event', {
    value: nodeEvent,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    value: nodeCustomEvent,
    configurable: true,
    writable: true,
  });
}, 30_000);
afterAll(() => {
  restoreDom?.();
});

let server: TestServer | undefined;
afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

const ORIGINAL = '# Original\n\noriginal body anchor\n';
const SUPERSEDING = '# Superseding\n\nsuperseding body anchor\n';
const TYPED = 'USER TYPED AFTER RESTORE POINT';

describe('rollback on the shipped path leaves the client undo stack invariant', () => {
  test('a real POST /api/rollback is not undoable, does not pop the user stack, and a stale item cannot resurrect the discarded content', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
    const docName = `qa050-${randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, ORIGINAL, { docName, position: 'replace' });
    await awaitWipCommits(server, docName, 1);
    const histRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
    );
    expect(histRes.status).toBe(200);
    const hist = (await histRes.json()) as { entries: Array<{ sha: string }> };
    const restoreSha = hist.entries[0]?.sha;
    expect(restoreSha).toBeTruthy();

    await agentWriteMd(server.port, SUPERSEDING, { docName, position: 'replace' });

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('superseding body anchor'), 10_000);

      const editor = mountCollabEditor(client.doc, []);
      try {
        const um = readUndoManager(editor) as Y.UndoManager;
        expect(um).not.toBeNull();

        insertLocal(editor, TYPED, 1);
        await pollUntil(() => client.ytext.toString().includes(TYPED), 10_000);
        const stackBefore = um.undoStack.length;
        expect(stackBefore).toBeGreaterThan(0);

        const rbRes = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docName, commitSha: restoreSha }),
        });
        expect(rbRes.status).toBe(200);

        await pollUntil(() => client.ytext.toString().includes('original body anchor'), 15_000);
        const afterRollback = client.ytext.toString();
        expect(afterRollback).not.toContain('superseding body anchor');

        expect(um.undoStack.length).toBe(stackBefore);

        await pollUntil(
          () => editor.state.doc.textContent.includes('original body anchor'),
          10_000,
        );

        um.undo();
        const fragAfterUndo = editor.state.doc.textContent;

        expect(fragAfterUndo).toContain('original body anchor');
        expect(fragAfterUndo).not.toContain('superseding body anchor');
        expect(fragAfterUndo).not.toContain(TYPED);
        expect(countOccurrences(fragAfterUndo, 'original body anchor')).toBe(1);
        expect(fragAfterUndo.trim().length).toBeGreaterThan(0);

        await awaitDocQuiescence(client.doc, { timeoutMs: 5_000 });
        await pollUntil(() => client.provider.unsyncedChanges === 0, 10_000);
        const ytextAfterUndo = client.ytext.toString();
        expect(ytextAfterUndo).toContain('original body anchor');
        expect(ytextAfterUndo).not.toContain('superseding body anchor');
        expect(ytextAfterUndo).not.toContain(TYPED);
        expect(countOccurrences(ytextAfterUndo, 'original body anchor')).toBe(1);
      } finally {
        editor.destroy();
      }
    } finally {
      await client.cleanup();
    }
  }, 60_000);
});
