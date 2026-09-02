/**
 * The markdown bridge is never attached, and quiescence tracking survives that.
 *
 * A client derives its ProseMirror document locally and never writes the
 * `Y.XmlFragment`. With the bridge attached, Observer A would serialize that
 * un-updated fragment and line-diff it back over `Y.Text`, reverting every
 * WYSIWYG keystroke to the last state the fragment knew. Only byte-writing
 * edits lose that race: Enter produces a block markdown cannot spell, which the
 * projection writes as ZERO bytes, so the server drain never wakes.
 *
 * These rows assert the ATTACH CALL directly rather than a side effect of it.
 * `setupServerObservers` does not derive at attach time — it records settlement
 * baselines from the current fragment and waits for a drain — so "did the
 * fragment populate?" is not a discriminator, and a suite built on one would
 * pass whether or not the bridge ran.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

/**
 * Load the extension with `setupServerObservers` stubbed, and return the
 * recorded attach calls.
 *
 * The stub has to be installed BEFORE the extension module is imported: the
 * extension binds the function at import time, so a spy applied afterwards
 * would never be consulted.
 */
async function loadWithStub(): Promise<{
  attachedDocs: string[];
  docs: Map<string, Y.Doc>;
  quiescence: typeof import('./bridge-quiescence.ts');
  attach: (documentName: string) => Promise<void>;
  unload: (documentName: string) => Promise<void>;
}> {
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
  vi.doUnmock('./server-observers.ts');
  vi.resetModules();
});

describe('the observer extension never attaches the bridge', () => {
  test('an ordinary markdown doc is declined', async () => {
    const rig = await loadWithStub();
    await rig.attach('notes/ordinary.md');
    expect(rig.attachedDocs).toEqual([]);
  });

  test('unloading a doc it never claimed is a no-op, not a throw', async () => {
    const rig = await loadWithStub();
    await rig.attach('notes/ordinary.md');
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
  });

  test('a declined doc STILL gets a quiescence tracker', async () => {
    // Tracking reads `Y.Doc` transactions only and has nothing to do with the
    // fragment, so it belongs outside every bridge skip. Its counters start
    // equal and `isDocQuiescent` is `settledGen > lastUserTxGen`, so an
    // untracked doc reports NOT quiescent forever — and persistence gates every
    // write on exactly that, deferring each store indefinitely.
    const rig = await loadWithStub();
    await rig.attach('notes/ordinary.md');
    expect(rig.attachedDocs).toEqual([]);

    const doc = rig.docs.get('notes/ordinary.md');
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    // A settled doc: a transaction, then the tracker's afterAll bump.
    doc.transact(() => doc.getText('source').insert(0, 'x'));
    expect(rig.quiescence.isDocQuiescent(doc)).toBe(true);
  });

  test('unload then reload leaves the doc tracked again', async () => {
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
    const rig = await loadWithStub();
    await rig.attach('notes/ordinary.md');
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
    await rig.attach('notes/ordinary.md');

    const doc = rig.docs.get('notes/ordinary.md');
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    doc.transact(() => doc.getText('source').insert(0, 'y'));
    expect(rig.quiescence.isDocQuiescent(doc)).toBe(true);
  });
});
