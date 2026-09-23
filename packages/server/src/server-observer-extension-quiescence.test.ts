import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import * as quiescence from './bridge-quiescence.ts';
import { createServerObserverExtension } from './server-observer-extension.ts';

function loadRig(): {
  docs: Map<string, Y.Doc>;
  attach: (documentName: string) => Promise<void>;
  unload: (documentName: string) => Promise<void>;
  destroy: () => Promise<void>;
} {
  const ext = createServerObserverExtension();
  const docs = new Map<string, Y.Doc>();
  return {
    docs,
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
    destroy: async () => {
      await ext.onDestroy?.({} as never);
    },
  };
}

function settle(rig: ReturnType<typeof loadRig>, documentName: string, text: string): Y.Doc {
  const doc = rig.docs.get(documentName);
  if (doc === undefined) throw new Error(`no doc for ${documentName}`);
  doc.transact(() => doc.getText('source').insert(0, text));
  return doc;
}

describe('the observer extension tracks quiescence and nothing else', () => {
  test('a loaded doc becomes quiescent after its transaction settles', async () => {
    const rig = loadRig();
    await rig.attach('notes/ordinary.md');

    expect(quiescence.isDocQuiescent(settle(rig, 'notes/ordinary.md', 'x'))).toBe(true);
  });

  test('unloading a doc it never claimed is a no-op, not a throw', async () => {
    const rig = loadRig();
    await expect(rig.unload('notes/never-loaded.md')).resolves.toBeUndefined();
  });

  test('unload then reload leaves the doc tracked again', async () => {
    const rig = loadRig();
    await rig.attach('notes/ordinary.md');
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
    await rig.attach('notes/ordinary.md');

    expect(quiescence.isDocQuiescent(settle(rig, 'notes/ordinary.md', 'y'))).toBe(true);
  });

  test('loading the same doc twice attaches one tracker, so one unload detaches it', async () => {
    const rig = loadRig();
    await rig.attach('notes/ordinary.md');
    await rig.attach('notes/ordinary.md');

    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
    await expect(rig.unload('notes/ordinary.md')).resolves.toBeUndefined();
  });

  test('destroy detaches every tracker it still holds', async () => {
    const rig = loadRig();
    await rig.attach('notes/one.md');
    await rig.attach('notes/two.md');

    await expect(rig.destroy()).resolves.toBeUndefined();
  });
});
