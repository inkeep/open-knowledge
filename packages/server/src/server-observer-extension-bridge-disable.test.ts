import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

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
    const rig = await loadWithStub();
    await rig.attach('notes/ordinary.md');
    expect(rig.attachedDocs).toEqual([]);

    const doc = rig.docs.get('notes/ordinary.md');
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    doc.transact(() => doc.getText('source').insert(0, 'x'));
    expect(rig.quiescence.isDocQuiescent(doc)).toBe(true);
  });

  test('unload then reload leaves the doc tracked again', async () => {
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
