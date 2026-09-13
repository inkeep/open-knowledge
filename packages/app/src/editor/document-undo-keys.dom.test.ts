import { describe, expect, it } from 'vitest';
import { documentUndoKeyAction } from './document-undo-keys';

interface Press {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

function press(init: Press, target: EventTarget | null = document.createElement('button')) {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...init,
    target,
  };
}

describe('documentUndoKeyAction', () => {
  it('reads Cmd+Z and Cmd+Shift+Z on macOS, and nothing else', () => {
    expect(documentUndoKeyAction(press({ key: 'z', metaKey: true }), 'mac')).toBe('undo');
    expect(documentUndoKeyAction(press({ key: 'Z', metaKey: true, shiftKey: true }), 'mac')).toBe(
      'redo',
    );
    expect(documentUndoKeyAction(press({ key: 'y', metaKey: true }), 'mac')).toBeNull();
    expect(documentUndoKeyAction(press({ key: 'z', ctrlKey: true }), 'mac')).toBeNull();
    expect(documentUndoKeyAction(press({ key: 'z' }), 'mac')).toBeNull();
  });

  it('reads Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y elsewhere', () => {
    const platform = 'windowsLinux';
    expect(documentUndoKeyAction(press({ key: 'z', ctrlKey: true }), platform)).toBe('undo');
    expect(
      documentUndoKeyAction(press({ key: 'Z', ctrlKey: true, shiftKey: true }), platform),
    ).toBe('redo');
    expect(documentUndoKeyAction(press({ key: 'y', ctrlKey: true }), platform)).toBe('redo');
    expect(documentUndoKeyAction(press({ key: 'z', metaKey: true }), platform)).toBeNull();
  });

  it('leaves editable targets to their own undo', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inside = document.createElement('p');
    editor.appendChild(inside);
    for (const target of [
      document.createElement('input'),
      document.createElement('textarea'),
      editor,
      inside,
    ]) {
      expect(documentUndoKeyAction(press({ key: 'z', metaKey: true }, target), 'mac')).toBeNull();
    }
  });

  it('skips a handled key and an Alt chord', () => {
    expect(
      documentUndoKeyAction(press({ key: 'z', metaKey: true, defaultPrevented: true }), 'mac'),
    ).toBeNull();
    expect(
      documentUndoKeyAction(press({ key: 'z', metaKey: true, altKey: true }), 'mac'),
    ).toBeNull();
  });
});
