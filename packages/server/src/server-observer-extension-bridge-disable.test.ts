/**
 * `OK_DISABLE_BRIDGE=1` detaches the markdown bridge from every document.
 *
 * The switch exists because the single-CRDT migration's manual pass is
 * otherwise impossible to perform correctly. A client running the projection
 * binding derives its ProseMirror document locally and never writes the
 * `Y.XmlFragment`; with the bridge still attached, Observer A serializes that
 * un-updated fragment and line-diffs it back over `Y.Text`, reverting every
 * WYSIWYG keystroke to the last state the fragment knew.
 *
 * The symptom that led here is worth recording, because it points anywhere but
 * at the bridge: typing a character jumps the caret back to the previous edit
 * point, while Enter behaves perfectly. Enter produces a block markdown cannot
 * spell, which the projection writes as ZERO bytes — so `Y.Text` never changes,
 * the server drain never wakes, and nothing stomps it. Only byte-writing edits
 * lose the race.
 *
 * These rows assert the ATTACH CALL directly rather than a side effect of it.
 * `setupServerObservers` does not derive at attach time (it records settlement
 * baselines from the current fragment and waits for a drain), so "did the
 * fragment populate?" is not a discriminator here, and a suite built on one
 * would pass whether or not the switch worked. A flag that silently does
 * nothing is the specific failure being guarded: that has already happened once
 * on this branch, when turbo's strict env mode dropped
 * `VITE_OK_PROJECTION_BINDING` before electron-vite could see it and the result
 * looked exactly like the projection path working and changing nothing.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

const ORIGINAL = process.env.OK_DISABLE_BRIDGE;

/**
 * Load the extension under a given env with `setupServerObservers` stubbed, and
 * return the recorded attach calls.
 *
 * The stub has to be installed BEFORE the extension module is imported: the
 * extension binds the function at import time, so a spy applied afterwards
 * would never be consulted. The switch is likewise read once at module load —
 * deliberately, so no doc can be half-bridged — which is why every row here
 * goes through a fresh module registry.
 */
async function loadWithStub(disabled: boolean): Promise<{
  attachedDocs: string[];
  docs: Map<string, Y.Doc>;
  quiescence: typeof import('./bridge-quiescence.ts');
  attach: (documentName: string) => Promise<void>;
  unload: (documentName: string) => Promise<void>;
}> {
  if (disabled) process.env.OK_DISABLE_BRIDGE = '1';
  else delete process.env.OK_DISABLE_BRIDGE;

  vi.resetModules();
  const attachedDocs: string[] = [];
  vi.doMock('./server-observers.ts', () => ({
    setupServerObservers: (args: { docName: string }) => {
      attachedDocs.push(args.docName);
      return () => {};
    },
    getPreDrainController: () => undefined,
  }));

  const mod = await import('./server-observer-extension.ts');
  const { mdManager, schema } = await import('./md-manager.ts');
  const ext = mod.createServerObserverExtension({ mdManager, schema } as never);

  const docs = new Map<string, Y.Doc>();
  const quiescence = await import('./bridge-quiescence.ts');
  return {
    attachedDocs,
    docs,
    quiescence,
    attach: async (documentName) => {
      const doc = new Y.Doc();
      doc.getText('source').insert(0, '# Heading\n\nBody text.\n');
      docs.set(documentName, doc);
      await ext.afterLoadDocument?.({ documentName, document: doc } as never);
    },
    unload: async (documentName) => {
      const doc = docs.get(documentName) ?? new Y.Doc();
      await ext.afterUnloadDocument?.({ documentName, document: doc } as never);
    },
  };
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OK_DISABLE_BRIDGE;
  else process.env.OK_DISABLE_BRIDGE = ORIGINAL;
  vi.doUnmock('./server-observers.ts');
  vi.resetModules();
});

describe('OK_DISABLE_BRIDGE', () => {
  test('unset: an ordinary markdown doc IS bridged', async () => {
    const rig = await loadWithStub(false);
    await rig.attach('notes/ordinary.md');
    // The control. Without this row the "declines" row below would pass against
    // an extension that never attaches anything.
    expect(rig.attachedDocs).toEqual(['notes/ordinary.md']);
  });

  test('unset: a config doc is still declined', async () => {
    const rig = await loadWithStub(false);
    await rig.attach('__config__/project');
    // The pre-existing Y.Text-only bypass, unchanged — the new switch generalises
    // this behaviour to every doc rather than replacing it.
    expect(rig.attachedDocs).toEqual([]);
  });

  test('set: the same markdown doc is declined', async () => {
    const rig = await loadWithStub(true);
    await rig.attach('notes/ordinary.md');
    expect(rig.attachedDocs).toEqual([]);
  });

  test('set: unloading a doc it never claimed is a no-op, not a throw', async () => {
    const rig = await loadWithStub(true);
    await rig.attach('notes/ordinary.md');
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
  });

  test('set: a declined doc STILL gets a quiescence tracker', async () => {
    // The bug that made `OK_DISABLE_BRIDGE=1` unusable: the tracker was
    // attached from inside `setupServerObservers`, so declining the bridge also
    // meant never attaching it. Its counters start equal and `isDocQuiescent`
    // is `settledGen > lastUserTxGen`, so an untracked doc reports NOT quiescent
    // forever — and persistence gates every write on exactly that, deferring
    // each store indefinitely. The app booted and then stalled.
    //
    // Tracking reads `Y.Doc` transactions only; it has nothing to do with the
    // fragment, so it belongs outside every bridge skip.
    const rig = await loadWithStub(true);
    await rig.attach('notes/ordinary.md');
    expect(rig.attachedDocs).toEqual([]);

    const doc = rig.docs.get('notes/ordinary.md');
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    // A settled doc: a transaction, then the tracker's afterAll bump.
    doc.transact(() => doc.getText('source').insert(0, 'x'));
    expect(rig.quiescence.isDocQuiescent(doc)).toBe(true);
  });

  test('set: unload then reload leaves the doc tracked again', async () => {
    // `afterUnloadDocument` returns early when there is no observer cleanup, so
    // the detach has to come BEFORE that return — otherwise a declined doc
    // keeps its tracker for the life of the process and the reload path double
    // attaches.
    //
    // Detaching is asserted through the reload rather than directly: it does
    // not reset the counters, only stops advancing them, so `isDocQuiescent`
    // cannot distinguish "detached" from "settled". What is observable, and
    // what actually matters, is that a doc still settles after a full
    // unload/reload cycle.
    const rig = await loadWithStub(true);
    await rig.attach('notes/ordinary.md');
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
    await rig.attach('notes/ordinary.md');

    const doc = rig.docs.get('notes/ordinary.md');
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    doc.transact(() => doc.getText('source').insert(0, 'y'));
    expect(rig.quiescence.isDocQuiescent(doc)).toBe(true);
  });

  test('set: flipping the env afterwards cannot half-bridge a run', async () => {
    const rig = await loadWithStub(true);
    process.env.OK_DISABLE_BRIDGE = '0';
    await rig.attach('notes/late.md');
    // Read-once is the point: a run where some docs are bridged and others are
    // not is worse than either state, because Observer A would stomp exactly
    // the subset that got attached.
    expect(rig.attachedDocs).toEqual([]);
  });
});
