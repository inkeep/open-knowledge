/**
 * CONTRACT — client undo topology under a rollback driven on the SHIPPED path.
 *
 * `undo-after-rollback.test.ts` pins the same ruling against a hand-reproduced
 * paired write (a local `document.transact(..., 'rollback-remote')` string
 * origin). That models the wire shape but never drives the production spine, so
 * a drift in `handleRollback` → `replaceRawBody` → `ROLLBACK_ORIGIN` — a
 * changed origin constant, a lost `transact` wrapper, a fragment rewrite
 * outside the paired origin — would leave the model green while Cmd+Z started
 * eating or resurrecting restored content in the product.
 *
 * This closes that seam: a real booted server, a real WebSocket client whose
 * Y.Doc carries a real Collaboration-bound editor and its fragment-scoped
 * `Y.UndoManager`, and a real `POST /api/rollback`. The rollback arrives at the
 * client as a genuine remote transaction, and the undo topology is asserted on
 * what actually arrived.
 *
 * A behavior flip here is an undo-topology regression to investigate, not a
 * test to silently re-baseline.
 *
 * WARN — this is NOT a guard on the individual lines of the rollback spine.
 * Measured: deleting `replaceRawBody`'s `updateYFragment` re-derive, deleting
 * its Y.Text overwrite, and clearing `ROLLBACK_ORIGIN`'s `paired: true` marker
 * each leave this test GREEN, because the bridge watchdog re-derives the
 * fragment behind all three. That is the watchdog doing its job, not a hole
 * here — but it means "qa-050 is green" must never be read as "those lines are
 * still needed". The `paired: true` marker is separately merge-gated by the
 * static scan in `paired-write-enforcement.test.ts`; do not "simplify" any of
 * these three on the strength of this suite passing.
 *
 */

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
  // The real WS transport constructs its events from the GLOBAL `Event`, and
  // node's EventTarget brand-check rejects jsdom's cross-realm one. Keep the
  // editor rig's DOM globals but hand node's Event back.
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

    // Version 1 — the restore target.
    await agentWriteMd(server.port, ORIGINAL, { docName, position: 'replace' });
    await awaitWipCommits(server, docName, 1);
    const histRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
    );
    expect(histRes.status).toBe(200);
    const hist = (await histRes.json()) as { entries: Array<{ sha: string }> };
    const restoreSha = hist.entries[0]?.sha;
    expect(restoreSha).toBeTruthy();

    // Version 2 — what the rollback will discard.
    await agentWriteMd(server.port, SUPERSEDING, { docName, position: 'replace' });

    const client = await createTestClient(server.port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('superseding body anchor'), 10_000);

      const editor = mountCollabEditor(client.doc, []);
      try {
        const um = readUndoManager(editor) as Y.UndoManager;
        expect(um).not.toBeNull();

        // The user types on top of version 2 — a genuine local, tracked edit.
        insertLocal(editor, TYPED, 1);
        await pollUntil(() => client.ytext.toString().includes(TYPED), 10_000);
        const stackBefore = um.undoStack.length;
        expect(stackBefore).toBeGreaterThan(0);

        // The shipped restore: real HTTP → handleRollback → replaceRawBody →
        // ROLLBACK_ORIGIN → over the wire to this client.
        const rbRes = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docName, commitSha: restoreSha }),
        });
        expect(rbRes.status).toBe(200);

        await pollUntil(() => client.ytext.toString().includes('original body anchor'), 15_000);
        const afterRollback = client.ytext.toString();
        expect(afterRollback).not.toContain('superseding body anchor');

        // (1) The rollback was NOT captured as an undoable item — the stack sits
        //     exactly where the user's own typing left it.
        expect(um.undoStack.length).toBe(stackBefore);

        // The restore must be visible on the surface the undo will act on
        // BEFORE the undo runs, or nothing below can discriminate.
        await pollUntil(
          () => editor.state.doc.textContent.includes('original body anchor'),
          10_000,
        );

        // `um` is FRAGMENT-scoped, so `um.undo()` mutates the XmlFragment, and
        // client-side cross-CRDT observers are deliberate no-ops (precedent #14)
        // — `client.ytext` therefore cannot change synchronously here. Reading it
        // straight back re-reads state already asserted above and would pass even
        // if the undo resurrected the discarded version or wiped the document.
        // Every assertion below observes the FRAGMENT (what the undo mutates)
        // and then the round trip back into Y.Text.
        um.undo();
        const fragAfterUndo = editor.state.doc.textContent;

        // (2) Cmd+Z does not revert the restore.
        expect(fragAfterUndo).toContain('original body anchor');
        // (3) The pre-rollback stack item cannot resurrect the discarded version
        //     or the user's own superseded typing.
        expect(fragAfterUndo).not.toContain('superseding body anchor');
        expect(fragAfterUndo).not.toContain(TYPED);
        // (4) Occurrence-count oracle on the post-undo fragment, with a lower
        //     bound: the undo neither spliced a second copy in nor emptied it.
        expect(countOccurrences(fragAfterUndo, 'original body anchor')).toBe(1);
        expect(fragAfterUndo.trim().length).toBeGreaterThan(0);

        // (5) Anything the undo emitted round-trips: client → server Observer A
        //     → Y.Text → back. The source bytes at rest still hold the restore
        //     exactly once, with nothing resurrected.
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
