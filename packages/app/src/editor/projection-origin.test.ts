import type { Transaction } from '@tiptap/pm/state';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mountProjectionEditor } from './editor-rig.test-helper';
import { isUserIntentOrigin } from './extensions/autonomous-fragment-edit';
import { flushMicrotasksAndTimers, installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | undefined;
beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});
afterAll(() => {
  restoreDomGlobals?.();
});

function recordOrigins(editor: ReturnType<typeof mountProjectionEditor>['editor']): boolean[] {
  const seen: boolean[] = [];
  editor.on('transaction', ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    seen.push(isUserIntentOrigin(transaction));
  });
  return seen;
}

describe('a remote re-derive is not something the user did', () => {
  it('classifies a peer edit as not user intent', async () => {
    const rig = mountProjectionEditor('seed line\n', []);
    try {
      await flushMicrotasksAndTimers();
      const seen = recordOrigins(rig.editor);

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(rig.ydoc));
      remote.transact(() => {
        const text = remote.getText('source');
        text.insert(text.toString().indexOf('\n'), ' from the peer');
      });
      Y.applyUpdate(rig.ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(rig.ydoc)), remote);
      remote.destroy();
      await flushMicrotasksAndTimers();

      expect(rig.editor.state.doc.textContent).toContain('from the peer');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((intent) => intent === false)).toBe(true);
    } finally {
      rig.destroy();
    }
  });

  it('classifies the local keystroke that follows as user intent', async () => {
    const rig = mountProjectionEditor('seed line\n', []);
    try {
      await flushMicrotasksAndTimers();

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(rig.ydoc));
      remote.transact(() => {
        const text = remote.getText('source');
        text.insert(text.toString().indexOf('\n'), ' from the peer');
      });
      Y.applyUpdate(rig.ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(rig.ydoc)), remote);
      remote.destroy();
      await flushMicrotasksAndTimers();

      const seen = recordOrigins(rig.editor);
      rig.editor.commands.insertContentAt(rig.editor.state.doc.content.size - 1, 'X');
      await flushMicrotasksAndTimers();

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((intent) => intent === true)).toBe(true);
    } finally {
      rig.destroy();
    }
  });
});
