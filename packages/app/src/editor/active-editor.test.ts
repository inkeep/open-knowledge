import { afterEach, describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { getEditorForDoc, registerEditor, unregisterEditor } from './active-editor';

const fakeEditor = (id: string): Editor => ({ __id: id }) as unknown as Editor;

describe('active-editor registry', () => {
  afterEach(() => {
    // Clear known docNames any test may have touched so cross-test bleed can't hide a bug.
    for (const doc of ['doc-a', 'doc-b', 'doc-concurrent']) {
      const current = getEditorForDoc(doc);
      if (current) unregisterEditor(doc, current);
    }
  });

  test('register + get returns the registered editor', () => {
    const e = fakeEditor('e1');
    registerEditor('doc-a', e);
    expect(getEditorForDoc('doc-a')).toBe(e);
  });

  test('unregister removes the entry when the ref matches', () => {
    const e = fakeEditor('e1');
    registerEditor('doc-a', e);
    unregisterEditor('doc-a', e);
    expect(getEditorForDoc('doc-a')).toBeNull();
  });

  test('unregister is a no-op when the ref does NOT match (StrictMode / HMR guard)', () => {
    // Simulates the StrictMode double-invoke ordering:
    //   mount-A → register(A)
    //   mount-B → register(B)   (last-writer overwrites)
    //   cleanup-A → unregister(A)   ← MUST NOT clobber B
    const a = fakeEditor('A');
    const b = fakeEditor('B');
    registerEditor('doc-concurrent', a);
    registerEditor('doc-concurrent', b);
    unregisterEditor('doc-concurrent', a); // stale cleanup from mount-A

    expect(getEditorForDoc('doc-concurrent')).toBe(b);
  });

  test('getEditorForDoc returns null for unknown docNames', () => {
    expect(getEditorForDoc('never-registered')).toBeNull();
  });

  test('registering the same docName overwrites last-writer-wins', () => {
    const a = fakeEditor('A');
    const b = fakeEditor('B');
    registerEditor('doc-b', a);
    registerEditor('doc-b', b);
    expect(getEditorForDoc('doc-b')).toBe(b);
  });
});
