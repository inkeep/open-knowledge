import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { documentUndoKeyAction, performHistoryCommand } from './document-undo-keys';

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

describe('performHistoryCommand', () => {
  const execCommand = vi.fn(() => true);
  let original: PropertyDescriptor | undefined;

  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  });
  afterEach(() => {
    execCommand.mockClear();
    document.body.replaceChildren();
  });
  afterAll(() => {
    if (original) Object.defineProperty(document, 'execCommand', original);
    else Reflect.deleteProperty(document, 'execCommand');
  });

  it('hands the key to the target and skips the browser when the target handles it', () => {
    const surface = document.createElement('div');
    const seen: string[] = [];
    surface.addEventListener('keydown', (event) => {
      seen.push(`${event.metaKey ? 'Meta-' : ''}${event.shiftKey ? 'Shift-' : ''}${event.key}`);
      event.preventDefault();
    });
    document.body.appendChild(surface);

    performHistoryCommand('redo', 'mac', surface);
    performHistoryCommand('undo', 'mac', surface);

    expect(seen).toEqual(['Meta-Shift-z', 'Meta-z']);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to the browser when nothing handles the key', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    performHistoryCommand('undo', 'windowsLinux', input);
    performHistoryCommand('redo', 'windowsLinux', null);

    expect(execCommand.mock.calls).toEqual([['undo'], ['redo']]);
  });
});
