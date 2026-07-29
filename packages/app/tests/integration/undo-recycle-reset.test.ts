/**
 * CONTRACT — client undo semantics across a provider-pool RECYCLE.
 *
 * Pins the ratified recycle-reset topology (recycle-reset is accepted per
 * industry norm; the timeline is the durable recovery rail): on a recycle the
 * pool destroys the provider + Y.Doc and re-opens with a FRESH Y.Doc
 * (recycleDisconnectedEntry); the editor remounts, so yUndoPlugin's state.init
 * re-runs into a fresh UndoManager with an EMPTY stack. Pre-recycle undo
 * history is therefore gone, and replayed unsynced edits land under
 * TAB_REPLAY_ORIGIN — which is not in the client UM's trackedOrigins, and lands
 * in Y.Text outside the fragment-scoped UM — so they are never Cmd+Z-undoable.
 * The observable shape ("Cmd+Z dead right after a recycle, then works") is
 * undo applying only to content typed AFTER the recycle. Content itself
 * survives (the server rebuilds from disk); only the undo history resets.
 *
 * A flip here (undo-history preservation across recycle) is an undo-topology
 * change to re-ratify, not a test to silently re-baseline.
 *
 * Fidelity: this drives the REAL server-instance-mismatch recycle end to end —
 * createRestartableServer + ProviderPool + killAndRestartOnSamePort → real auth
 * rejection → real handleServerInstanceMismatch (buffer → clearData →
 * recycleAllEntries) → real buffer replay on the fresh provider's first
 * `synced`. The editor is a real Collaboration-bound editor over
 * provider.document — the same binding production uses. The production
 * editor-cache eviction + React remount is emulated by a pool.onEvict editor
 * destroy() plus a fresh mountCollabEditor after the recycled provider syncs
 * (production also mounts after the sync promise resolves, i.e. after replay
 * ran). The clean-disconnect debounce trigger is pushed out of the window via
 * recycleDebounceMs so the trigger under test is unambiguous; it converges on
 * the same recycleDisconnectedEntry spine. Collaboration's restore wrapper
 * neutralizes the upstream y-prosemirror #114 lifecycle bug on the SAME editor,
 * so any deadness here is the recycle boundary, not #114.
 *
 */

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
  // Node's undici WebSocket (the pool transport in this probe) constructs
  // its 'open'/'message' events from the GLOBAL `Event` at dispatch time,
  // and node's EventTarget brand-check rejects jsdom's cross-realm Event.
  // installDomGlobals() overrides Event/CustomEvent for the editor rig —
  // restore node's originals so the real WS transport keeps working
  // (ProseMirror's headless dispatch path never constructs global Events).
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

/** Structured-recovery-event capture: ProviderPool emits its recovery
 * telemetry via `console.warn(JSON.stringify({event, ...}))`. Recording them
 * gives measured proof of which recycle/replay branch actually ran. */
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
      } catch {
        /* not a structured event */
      }
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
  /** Origins of every update applied to the post-recycle fresh Y.Doc. */
  freshDocUpdateOrigins: unknown[];
  /** docNames evicted (destroyEntry → fireEvict) — recycle proof. */
  evictedDocNames: string[];
}

/**
 * Boot server + pool + a real Collaboration editor on the pool provider's
 * Y.Doc, synced on BASE_MD. Wires the production-shaped eviction hook:
 * on evict, destroy the bound editor (editor-cache analog) and attach an
 * update-origin probe to the fresh entry's Y.Doc via queueMicrotask —
 * recycleDisconnectedEntry runs destroy→reopen synchronously, so the
 * microtask sees the fresh doc before any WS I/O can deliver updates.
 */
async function bootRig(): Promise<Rig> {
  const { events, names } = captureStructuredWarns();
  const handle = await createRestartableServer();
  const srv = { handle };
  cleanups.push(() => srv.handle.shutdown());
  writeFileSync(join(srv.handle.contentDir, `${DOC}.md`), BASE_MD, 'utf-8');
  await wait(250); // file-watcher pickup (T14 precedent)

  const pool = new ProviderPool(3, `ws://127.0.0.1:${srv.handle.port}/collab`, {
    // Pin the recycle trigger under test to `server-instance-mismatch`
    // (§2e trigger 2). The clean-disconnect 4s debounce (trigger 1) would
    // otherwise race the reconnect across our restart window; both
    // triggers converge on recycleDisconnectedEntry anyway.
    recycleDebounceMs: 60_000,
  });
  cleanups.push(() => pool.dispose());
  // Production boot shape: client claims the live serverInstanceId in its
  // auth token; after a restart the claim is stale → mismatch fires.
  await seedPoolServerInstanceId(srv.handle, pool);

  pool.open(DOC);
  pool.setActive(DOC);
  await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);

  const entry = pool.getActive();
  if (!entry || entry.kind !== 'active') throw new Error('no active entry after sync');

  // Production binding shape (TiptapEditor.tsx:331): Collaboration over
  // provider.document. Mounted after first sync, as production does
  // (Suspense gates the editor mount on the syncPromise).
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
    // editor-cache analog: destroy the editor bound to the evicted doc
    // BEFORE provider.destroy() tears the Y.Doc down.
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

/**
 * ClientIDs whose local clock is AHEAD of the recycle baseline — i.e. work the
 * baseline does not cover and the recycle therefore has to carry.
 *
 * Compared as state vectors, deliberately not as `encodeStateAsUpdate` byte
 * length: an update always carries the doc's full delete set, so a doc with any
 * deletion in it never encodes down to an empty envelope even when the baseline
 * already covers every struct. Byte length would read "unacked" forever and the
 * gate below would never bite.
 *
 * The baseline is the one `replayBufferedContent` computes against:
 * `lastDiskAckedSV`, falling back to `lastServerSyncedSV`.
 */
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

/**
 * Type + propagate: fragment → server Observer A → Y.Text → L1 disk flush, then
 * doc quiescence + unsyncedChanges drained. On return the edit is DURABLE — it
 * is on disk and fully sent — and both facts are asserted here rather than
 * timed.
 *
 * It is NOT acknowledged into the recycle baseline, and this helper does not
 * try to make it so. `lastServerSyncedSV` refreshes only on a provider `synced`
 * event, which does not re-fire for a local edit, so no amount of waiting moves
 * an edit into it; `lastDiskAckedSV` advances on disk-ack but lags the doc's
 * current state. An earlier version of this comment claimed the opposite —
 * "leaves the edit ACKED in lastServerSyncedSV" — and asserting that claim
 * times out. The unacked window is the state the recycle exists to survive, so
 * `restartAndAwaitRecycledSync` pins it at the moment it matters.
 */
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

/** Kill network, optionally run `whileDown`, restart on the same port (new
 * ServerInstance ⇒ new serverInstanceId ⇒ stale auth claim ⇒ REAL
 * `server-instance-mismatch` recycle), then wait for the recycled entry —
 * a NEW provider + NEW Y.Doc — to sync. Returns the fresh entry. */
async function restartAndAwaitRecycledSync(
  rig: Rig,
  whileDown?: () => void,
): Promise<{ provider: { document: Y.Doc; isSynced: boolean } }> {
  const before = rig.pool.getActive();
  if (!before || before.kind !== 'active') throw new Error('no active entry pre-restart');
  const providerBefore = before.provider;

  rig.srv.handle.killNetwork();
  // Let the provider observe the transport close before editing offline.
  await pollUntil(() => rig.pool.getActive()?.syncState === 'disconnected', 5_000, 25);
  whileDown?.();

  // SCENARIO GATE — the recycle must be BUFFER-CARRIED, not disk-carried.
  //
  // The durability claim this suite defends is that work the server has not
  // acknowledged survives a recycle; the RAM buffer and the durable outbox are
  // the carriers for exactly that window. If the staging ever drifts so the
  // recycle baseline already covers the doc, the restart rebuild alone restores
  // everything, nothing is carried, and every assertion downstream still passes
  // — the suite would silently downgrade to the easy case. Fail loudly instead.
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
    // The typed content is reverted; base content is untouched.
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

    // Production remount: fresh editor over the fresh provider.document,
    // mounted after the recycled provider synced.
    const editorB = mountCollabEditor(fresh.provider.document, []);
    cleanups.push(() => editorB.destroy());
    const umB = readUndoManager(editorB);
    if (!umB) throw new Error('no UM on post-recycle editor');

    const textAfterRecycle = editorB.state.doc.textContent;
    const stackAfterRecycle = umB.undoStack.length;
    const redoAfterRecycle = umB.redoStack.length;
    const popped = umB.undo();
    const textAfterUndo = editorB.state.doc.textContent;

    // The recycle ran via the real mismatch path.
    expect(rig.eventNames()).toContain('ok-client-cache-epoch-mismatch');
    expect(rig.evictedDocNames).toContain(DOC);
    // Content survived (server rebuilt from disk, which had the edit)…
    expect(textAfterRecycle).toContain('M2-PRE-RECYCLE-TYPED');
    expect(textAfterRecycle).toContain('base paragraph anchor');
    // …but the undo history did NOT: fresh manager, empty stacks.
    expect(umB).not.toBe(umA);
    expect(stackAfterRecycle).toBe(0);
    expect(redoAfterRecycle).toBe(0);
    // Cmd+Z immediately after the recycle does nothing.
    expect(popped).toBeNull();
    expect(textAfterUndo).toBe(textAfterRecycle);
  }, 30_000);

  test('a replayed unsynced edit lands under TAB_REPLAY_ORIGIN and is not undoable', async () => {
    const rig = await bootRig();
    const umA = rig.um;
    const stackBeforeOffline = umA.undoStack.length;

    // Offline WYSIWYG edit: lands in the FRAGMENT only (server Observer A
    // is unreachable, so Y.Text never receives it — the un-drained edit
    // shape replayBufferedContent's `ytextClean && !fragClean` branch
    // recovers).
    let stackAfterOfflineType = -1;
    const fresh = await restartAndAwaitRecycledSync(rig, () => {
      insertLocal(rig.editor, 'M3-UNSYNCED-EDIT ', 1);
      stackAfterOfflineType = umA.undoStack.length;
    });

    // Give the replay + its post-splice sync a beat, then measure.
    const freshDoc = fresh.provider.document;
    await pollUntil(
      () => freshDoc.getText('source').toString().includes('M3-UNSYNCED-EDIT'),
      10_000,
      50,
    );
    const ytextHasEdit = freshDoc.getText('source').toString().includes('M3-UNSYNCED-EDIT');
    const replayOriginSeen = rig.freshDocUpdateOrigins.some((o) => o === TAB_REPLAY_ORIGIN);

    // Production remount timing: editor mounts after the recycled provider
    // synced — the replay (first-`synced` listener) has already run.
    const editorB = mountCollabEditor(freshDoc, []);
    cleanups.push(() => editorB.destroy());
    const umB = readUndoManager(editorB);
    if (!umB) throw new Error('no UM on post-recycle editor');

    const stackAtMount = umB.undoStack.length;

    // The replay wrote Y.TEXT; the editor renders the FRAGMENT. The edit
    // becomes visible only after the real server Observer B derives the
    // fragment from Y.Text and syncs it back as a remote update.
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

    // Pre-recycle: the offline WYSIWYG edit WAS captured by the old UM.
    expect(stackAfterOfflineType).toBeGreaterThan(stackBeforeOffline);
    // The real mismatch recycle + content-level replay ran.
    expect(rig.eventNames()).toContain('ok-client-cache-epoch-mismatch');
    expect(rig.eventNames()).toContain('ok-buffer-replay-content-applied');
    // Replayed bytes DID land (in Y.Text), under the real TAB_REPLAY_ORIGIN.
    expect(ytextHasEdit).toBe(true);
    expect(replayOriginSeen).toBe(true);
    // The fresh UM captured NONE of it — not at mount, not after the
    // Observer-B fragment round-trip (remote origin ∉ trackedOrigins).
    expect(stackAtMount).toBe(0);
    expect(editorShowsEditAfterRoundTrip).toBe(true);
    expect(stackAfterRoundTrip).toBe(0);
    // Cmd+Z cannot undo the replayed edit.
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

    // Try #1 (immediately after recycle): dead.
    const try1 = umB.undo();
    const textAfterTry1 = editorB.state.doc.textContent;

    // User keeps working: NEW content accumulates on the fresh stack.
    insertLocal(editorB, 'M4-POST-RECYCLE-NEW ', 1);
    const stackAfterNewTyping = umB.undoStack.length;

    // Try #2: works — but only for the NEW content.
    const try2 = umB.undo();
    const textAfterTry2 = editorB.state.doc.textContent;

    // Try #3: dead again — the recycle boundary is a hard floor; undo can
    // never reach pre-recycle content.
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
