import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { Editor } from '@tiptap/core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  insertLocal,
  mountCollabEditor,
  readUndoManager,
} from '../../src/editor/editor-rig.test-helper';
import { ProviderPool, TAB_REPLAY_ORIGIN } from '../../src/editor/provider-pool';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  awaitDocQuiescence,
  createRestartableServer,
  pollUntil,
  readTestDoc,
  seedPoolServerInstanceId,
} from './test-harness';

const BASE_MD = '# Recycle Probe\n\nbase paragraph anchor\n';
const DOC = 'test-doc';

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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function captureStructuredWarns(): {
  events: Array<Record<string, unknown>>;
  names: () => string[];
} {
  const original = console.warn;
  const events: Array<Record<string, unknown>> = [];
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string') {
      try {
        const parsed: unknown = JSON.parse(first);
        if (parsed !== null && typeof parsed === 'object' && 'event' in parsed) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {}
    }
    original.apply(console, args as Parameters<typeof console.warn>);
  };
  cleanups.push(() => {
    console.warn = original;
  });
  return { events, names: () => events.map((e) => String(e.event)) };
}

interface Rig {
  srv: { handle: Awaited<ReturnType<typeof createRestartableServer>> };
  pool: ProviderPool;
  editor: Editor;
  um: Y.UndoManager;
  events: Array<Record<string, unknown>>;
  eventNames: () => string[];
  freshDocUpdateOrigins: unknown[];
  evictedDocNames: string[];
}

async function bootRig(): Promise<Rig> {
  const { events, names } = captureStructuredWarns();
  const handle = await createRestartableServer();
  const srv = { handle };
  cleanups.push(() => srv.handle.shutdown());
  writeFileSync(join(srv.handle.contentDir, `${DOC}.md`), BASE_MD, 'utf-8');
  await wait(250);

  const pool = new ProviderPool(3, `ws://127.0.0.1:${srv.handle.port}/collab`, {
    recycleDebounceMs: 60_000,
  });
  cleanups.push(() => pool.dispose());
  await seedPoolServerInstanceId(srv.handle, pool);

  pool.open(DOC);
  pool.setActive(DOC);
  await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

  const entry = pool.getActive();
  if (!entry || entry.kind !== 'active') throw new Error('no active entry after sync');

  const editor = mountCollabEditor(entry.provider.document, []);
  const live = { editor, destroyed: false };
  cleanups.push(() => {
    if (!live.destroyed) live.editor.destroy();
  });
  const um = readUndoManager(editor);
  if (!um) throw new Error('no UndoManager on collab editor');

  const freshDocUpdateOrigins: unknown[] = [];
  const evictedDocNames: string[] = [];
  pool.onEvict((docName) => {
    evictedDocNames.push(docName);
    if (docName === DOC && !live.destroyed) {
      live.editor.destroy();
      live.destroyed = true;
    }
    queueMicrotask(() => {
      const fresh = pool.getActive();
      if (fresh && fresh.kind === 'active' && fresh.provider.document !== entry.provider.document) {
        fresh.provider.document.on('update', (_update: Uint8Array, origin: unknown) => {
          freshDocUpdateOrigins.push(origin);
        });
      }
    });
  });

  return {
    srv,
    pool,
    editor,
    um,
    events,
    eventNames: names,
    freshDocUpdateOrigins,
    evictedDocNames,
  };
}

function unackedClientsAtBaseline(entry: {
  lastDiskAckedSV: Uint8Array | null;
  lastServerSyncedSV: Uint8Array | null;
  provider: { document: Y.Doc };
}): number[] {
  const baseline = entry.lastDiskAckedSV ?? entry.lastServerSyncedSV;
  if (!baseline) return [...Y.encodeStateVector(entry.provider.document).keys()];
  const acked = Y.decodeStateVector(baseline);
  const live = Y.decodeStateVector(Y.encodeStateVector(entry.provider.document));
  const ahead: number[] = [];
  for (const [client, clock] of live) {
    if ((acked.get(client) ?? 0) < clock) ahead.push(client);
  }
  return ahead;
}

async function typeAndPropagate(rig: Rig, text: string): Promise<void> {
  insertLocal(rig.editor, text, 1);
  const entry = rig.pool.getActive();
  if (!entry) throw new Error('no active entry');
  await pollUntil(() => readTestDoc(rig.srv.handle.contentDir, DOC).includes(text), 10_000, 100);
  await awaitDocQuiescence(entry.provider.document, { timeoutMs: 5_000 });
  await pollUntil(() => entry.provider.unsyncedChanges === 0, 10_000, 50);
  expect(readTestDoc(rig.srv.handle.contentDir, DOC)).toContain(text);
  expect(entry.provider.unsyncedChanges).toBe(0);
}

async function restartAndAwaitRecycledSync(
  rig: Rig,
  whileDown?: () => void,
): Promise<{ provider: { document: Y.Doc; isSynced: boolean } }> {
  const before = rig.pool.getActive();
  if (!before || before.kind !== 'active') throw new Error('no active entry pre-restart');
  const providerBefore = before.provider;

  rig.srv.handle.killNetwork();
  await pollUntil(() => rig.pool.getActive()?.syncState === 'disconnected', 5_000, 25);
  whileDown?.();

  const unackedClients = unackedClientsAtBaseline(before);
  expect(
    unackedClients.length,
    'recycle staging drifted to the ACKED/disk-carried case: the baseline already covers the doc, so neither the replay buffer nor the durable outbox carries anything and this suite is no longer testing the unacked window',
  ).toBeGreaterThan(0);

  rig.srv.handle = await rig.srv.handle.killAndRestartOnSamePort({ downtimeMs: 400 });

  await pollUntil(
    () => {
      const e = rig.pool.getActive();
      return e?.kind === 'active' && e.provider !== providerBefore && e.provider.isSynced === true;
    },
    20_000,
    50,
  );
  const fresh = rig.pool.getActive();
  if (!fresh || fresh.kind !== 'active') throw new Error('no recycled entry');
  if (fresh.provider.document === providerBefore.document) {
    throw new Error('expected a FRESH Y.Doc after recycle');
  }
  return fresh;
}

describe('client undo across a provider-pool recycle', () => {
  test('baseline (no recycle): typing is captured and undo reverts it', async () => {
    const rig = await bootRig();

    insertLocal(rig.editor, 'M1-TYPED-MARKER', 1);
    expect(rig.editor.state.doc.textContent).toContain('M1-TYPED-MARKER');
    expect(rig.um.undoStack.length).toBeGreaterThan(0);

    const popped = rig.um.undo();
    expect(popped).not.toBeNull();
    expect(rig.editor.state.doc.textContent).not.toContain('M1-TYPED-MARKER');
    expect(rig.editor.state.doc.textContent).toContain('base paragraph anchor');
  }, 30_000);

  test('after a recycle, the fresh UndoManager starts empty and undo is a no-op', async () => {
    const rig = await bootRig();

    await typeAndPropagate(rig, 'M2-PRE-RECYCLE-TYPED ');
    const umA = rig.um;
    const stackBeforeRecycle = umA.undoStack.length;
    expect(stackBeforeRecycle).toBeGreaterThan(0);

    const fresh = await restartAndAwaitRecycledSync(rig);

    const editorB = mountCollabEditor(fresh.provider.document, []);
    cleanups.push(() => editorB.destroy());
    const umB = readUndoManager(editorB);
    if (!umB) throw new Error('no UM on post-recycle editor');

    const textAfterRecycle = editorB.state.doc.textContent;
    const stackAfterRecycle = umB.undoStack.length;
    const redoAfterRecycle = umB.redoStack.length;
    const popped = umB.undo();
    const textAfterUndo = editorB.state.doc.textContent;

    expect(rig.eventNames()).toContain('ok-client-cache-epoch-mismatch');
    expect(rig.evictedDocNames).toContain(DOC);
    expect(textAfterRecycle).toContain('M2-PRE-RECYCLE-TYPED');
    expect(textAfterRecycle).toContain('base paragraph anchor');
    expect(umB).not.toBe(umA);
    expect(stackAfterRecycle).toBe(0);
    expect(redoAfterRecycle).toBe(0);
    expect(popped).toBeNull();
    expect(textAfterUndo).toBe(textAfterRecycle);
  }, 30_000);

  test('a replayed unsynced edit lands under TAB_REPLAY_ORIGIN and is not undoable', async () => {
    const rig = await bootRig();
    const umA = rig.um;
    const stackBeforeOffline = umA.undoStack.length;

    let stackAfterOfflineType = -1;
    const fresh = await restartAndAwaitRecycledSync(rig, () => {
      insertLocal(rig.editor, 'M3-UNSYNCED-EDIT ', 1);
      stackAfterOfflineType = umA.undoStack.length;
    });

    const freshDoc = fresh.provider.document;
    await pollUntil(
      () => freshDoc.getText('source').toString().includes('M3-UNSYNCED-EDIT'),
      10_000,
      50,
    );
    const ytextHasEdit = freshDoc.getText('source').toString().includes('M3-UNSYNCED-EDIT');
    const replayOriginSeen = rig.freshDocUpdateOrigins.some((o) => o === TAB_REPLAY_ORIGIN);

    const editorB = mountCollabEditor(freshDoc, []);
    cleanups.push(() => editorB.destroy());
    const umB = readUndoManager(editorB);
    if (!umB) throw new Error('no UM on post-recycle editor');

    const stackAtMount = umB.undoStack.length;

    let editorShowsEditAfterRoundTrip = false;
    try {
      await pollUntil(
        () => editorB.state.doc.textContent.includes('M3-UNSYNCED-EDIT'),
        10_000,
        100,
      );
      editorShowsEditAfterRoundTrip = true;
    } catch {
      editorShowsEditAfterRoundTrip = false;
    }
    const stackAfterRoundTrip = umB.undoStack.length;
    const popped = umB.undo();
    const editStillPresentAfterUndo = editorB.state.doc.textContent.includes('M3-UNSYNCED-EDIT');

    expect(stackAfterOfflineType).toBeGreaterThan(stackBeforeOffline);
    expect(rig.eventNames()).toContain('ok-client-cache-epoch-mismatch');
    expect(rig.eventNames()).toContain('ok-buffer-replay-content-applied');
    expect(ytextHasEdit).toBe(true);
    expect(replayOriginSeen).toBe(true);
    expect(stackAtMount).toBe(0);
    expect(editorShowsEditAfterRoundTrip).toBe(true);
    expect(stackAfterRoundTrip).toBe(0);
    expect(popped).toBeNull();
    expect(editStillPresentAfterUndo).toBe(true);
  }, 30_000);

  test('after a recycle, undo works only for content typed after the recycle', async () => {
    const rig = await bootRig();
    await typeAndPropagate(rig, 'M4-PRE-RECYCLE-TYPED ');

    const fresh = await restartAndAwaitRecycledSync(rig);
    const editorB = mountCollabEditor(fresh.provider.document, []);
    cleanups.push(() => editorB.destroy());
    const umB = readUndoManager(editorB);
    if (!umB) throw new Error('no UM on post-recycle editor');

    const try1 = umB.undo();
    const textAfterTry1 = editorB.state.doc.textContent;

    insertLocal(editorB, 'M4-POST-RECYCLE-NEW ', 1);
    const stackAfterNewTyping = umB.undoStack.length;

    const try2 = umB.undo();
    const textAfterTry2 = editorB.state.doc.textContent;

    const try3 = umB.undo();
    const textAfterTry3 = editorB.state.doc.textContent;

    expect(try1).toBeNull();
    expect(textAfterTry1).toContain('M4-PRE-RECYCLE-TYPED');
    expect(stackAfterNewTyping).toBeGreaterThan(0);
    expect(try2).not.toBeNull();
    expect(textAfterTry2).not.toContain('M4-POST-RECYCLE-NEW');
    expect(textAfterTry2).toContain('M4-PRE-RECYCLE-TYPED');
    expect(try3).toBeNull();
    expect(textAfterTry3).toContain('M4-PRE-RECYCLE-TYPED');
    expect(textAfterTry3).toContain('base paragraph anchor');
  }, 30_000);
});
