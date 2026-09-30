import { Plugin, PluginKey } from '@tiptap/pm/state';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { insertLocal, mountProjectionEditor } from '../../src/editor/editor-rig.test-helper';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  restoreDom = installDomGlobals();
}, 30_000);
afterAll(() => {
  restoreDom?.();
});

function makeHarmlessPlugin(name: string): Plugin {
  return new Plugin({ key: new PluginKey(name) });
}

describe('client undo survives editor plugin churn', () => {
  test('baseline: typing then undo reverts the edit (undo alive without any reconfigure)', () => {
    const rig = mountProjectionEditor('\n', []);
    try {
      insertLocal(rig.editor, 'hello world', 1);
      expect(rig.editor.state.doc.textContent).toContain('hello world');
      expect(rig.undoManager.undoStack.length).toBeGreaterThan(0);

      rig.undoManager.undo();
      expect(rig.editor.state.doc.textContent).not.toContain('hello world');
    } finally {
      rig.destroy();
    }
  });

  test('registerPlugin before the first keystroke does not kill undo', () => {
    const rig = mountProjectionEditor('\n', []);
    try {
      const umBefore = rig.undoManager;
      const obs = (rig.ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
      const beforeHandlers = obs.get('afterTransaction')?.size ?? 0;

      rig.editor.registerPlugin(makeHarmlessPlugin('probe-flash'));

      const afterHandlers = obs.get('afterTransaction')?.size ?? 0;

      insertLocal(rig.editor, 'typed after register', 1);
      const captured = rig.undoManager.undoStack.length;
      rig.undoManager.undo();
      const revertedByUndo = !rig.editor.state.doc.textContent.includes('typed after register');

      expect(rig.undoManager).toBe(umBefore);
      expect(afterHandlers).toBe(beforeHandlers);
      expect(captured).toBeGreaterThan(0);
      expect(revertedByUndo).toBe(true);
    } finally {
      rig.destroy();
    }
  });

  test('register + unregister churn also preserves undo', () => {
    const rig = mountProjectionEditor('\n', []);
    try {
      const key = new PluginKey('probe-removable');
      rig.editor.registerPlugin(new Plugin({ key }));
      rig.editor.unregisterPlugin(key);

      insertLocal(rig.editor, 'edit after churn', 1);
      const captured = rig.undoManager.undoStack.length;
      rig.undoManager.undo();
      const reverted = !rig.editor.state.doc.textContent.includes('edit after churn');
      expect(captured).toBeGreaterThan(0);
      expect(reverted).toBe(true);
    } finally {
      rig.destroy();
    }
  });
});
