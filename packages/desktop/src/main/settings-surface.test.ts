import { describe, expect, test, vi } from 'vitest';

import {
  openSettingsSurface,
  resolveSettingsSurface,
  resolveSettingsWindowKind,
  type SettingsSurfaceDeps,
  type SettingsWindowKind,
  settingsHash,
  settingsHashScript,
} from './settings-surface.ts';

interface FakeWindow {
  id: number;
  kind: SettingsWindowKind;
}

function win(id: number, kind: SettingsWindowKind): FakeWindow {
  return { id, kind };
}

function depsFor(
  focused: FakeWindow | null,
  all: readonly FakeWindow[],
): SettingsSurfaceDeps<FakeWindow> {
  return {
    kindOf: (w) => w.kind,
    getFocusedWindow: () => focused,
    getAllWindows: () => all,
  };
}

describe('resolveSettingsWindowKind', () => {
  const project = { ephemeral: false };
  const singleFile = { ephemeral: true };
  const navigator = { id: 1 };
  const editor = { id: 2 };
  const singleFileEditor = { id: 3 };
  const note = { id: 4 };
  const terminal = { id: 5 };
  const other = { id: 6 };
  const destroyed = { id: 7 };
  const editors = new Map([
    [editor.id, project],
    [singleFileEditor.id, singleFile],
    [destroyed.id, project],
  ]);
  const notes = new Map([[note.id, {}]]);
  const terminals = new Map([[terminal.id, {}]]);
  const deps = {
    isDestroyed: (target: { id: number }) => target === destroyed,
    isNavigator: (target: { id: number }) => target === navigator,
    getEditorContext: (target: { id: number }) => editors.get(target.id),
    getNoteContext: (target: { id: number }) => notes.get(target.id),
    getTerminalContext: (target: { id: number }) => terminals.get(target.id),
  };

  test.each([
    [navigator, 'navigator'],
    [editor, 'editor'],
    [singleFileEditor, 'editor'],
    [note, 'note'],
    [terminal, 'terminal'],
    [other, 'other'],
    [destroyed, 'other'],
  ] as const)('classifies window %j as %s from its registry', (target, expected) => {
    expect(resolveSettingsWindowKind(target, deps)).toBe(expected);
  });

  test('keeps Settings in a single-file editor with another project behind it', () => {
    expect(
      resolveSettingsSurface(singleFileEditor, {
        kindOf: (target) => resolveSettingsWindowKind(target, deps),
        getFocusedWindow: () => singleFileEditor,
        getAllWindows: () => [editor, singleFileEditor, navigator],
      }),
    ).toEqual({ kind: 'editor', window: singleFileEditor });
  });
});

describe('resolveSettingsSurface', () => {
  test('an explicit editor window wins over a focused navigator', () => {
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(editor, depsFor(navigator, [navigator, editor]))).toEqual({
      kind: 'editor',
      window: editor,
    });
  });

  test('an explicit navigator window hosts the navigator surface', () => {
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(navigator, depsFor(null, [navigator]))).toEqual({
      kind: 'navigator',
      window: navigator,
    });
  });

  test('an explicit window that cannot host settings falls through to focus', () => {
    const note = win(3, 'note');
    const editor = win(1, 'editor');
    expect(resolveSettingsSurface(note, depsFor(editor, [note, editor]))).toEqual({
      kind: 'editor',
      window: editor,
    });
  });

  test('the focused editor window is the target', () => {
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(null, depsFor(editor, [navigator, editor]))).toEqual({
      kind: 'editor',
      window: editor,
    });
  });

  test('a focused navigator is the target even when an editor window is open behind it', () => {
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(null, depsFor(navigator, [editor, navigator]))).toEqual({
      kind: 'navigator',
      window: navigator,
    });
  });

  test('a focused terminal window defers to an open editor window', () => {
    const terminal = win(4, 'terminal');
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(null, depsFor(terminal, [navigator, terminal, editor]))).toEqual({
      kind: 'editor',
      window: editor,
    });
  });

  test('a focused note window with only the navigator open lands on the navigator', () => {
    const note = win(3, 'note');
    const navigator = win(2, 'navigator');
    expect(resolveSettingsSurface(null, depsFor(note, [note, navigator]))).toEqual({
      kind: 'navigator',
      window: navigator,
    });
  });

  test('no windows at all resolves to none', () => {
    expect(resolveSettingsSurface(null, depsFor(null, []))).toEqual({ kind: 'none' });
  });

  test('windows of unknown kind never host settings', () => {
    const other = win(9, 'other');
    expect(resolveSettingsSurface(other, depsFor(other, [other]))).toEqual({ kind: 'none' });
  });

  describe('editorOnly', () => {
    test('skips a focused navigator when an editor window exists', () => {
      const editor = win(1, 'editor');
      const navigator = win(2, 'navigator');
      expect(
        resolveSettingsSurface(null, depsFor(navigator, [navigator, editor]), {
          editorOnly: true,
        }),
      ).toEqual({ kind: 'editor', window: editor });
    });

    test('resolves to none when only the navigator is open', () => {
      const navigator = win(2, 'navigator');
      expect(
        resolveSettingsSurface(navigator, depsFor(navigator, [navigator]), { editorOnly: true }),
      ).toEqual({ kind: 'none' });
    });
  });
});

describe('openSettingsSurface', () => {
  function harness(focused: FakeWindow | null, all: readonly FakeWindow[]) {
    return {
      ...depsFor(focused, all),
      showEditor: vi.fn(),
      showNavigator: vi.fn(() => true),
      openNavigator: vi.fn(),
      onEditorRequired: vi.fn(),
    };
  }

  test('opens customization in the focused navigator while a project is open', () => {
    const navigator = win(1, 'navigator');
    const deps = harness(navigator, [win(2, 'editor'), navigator]);

    openSettingsSurface(null, deps);

    expect(deps.showNavigator).toHaveBeenCalledExactlyOnceWith(navigator);
    expect(deps.showEditor).not.toHaveBeenCalled();
    expect(deps.openNavigator).not.toHaveBeenCalled();
  });

  test('opens full settings in the requesting editor even after focus has changed', () => {
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    const deps = harness(navigator, [editor, navigator]);

    openSettingsSurface(editor, deps);

    expect(deps.showEditor).toHaveBeenCalledExactlyOnceWith(editor, undefined);
    expect(deps.showNavigator).not.toHaveBeenCalled();
  });

  test('arms customization before creating the first navigator', () => {
    const deps = harness(null, []);
    deps.openNavigator.mockImplementation(() => {
      expect(deps.showNavigator).toHaveBeenCalledExactlyOnceWith(null);
    });

    openSettingsSurface(null, deps);

    expect(deps.openNavigator).toHaveBeenCalledOnce();
    expect(deps.showEditor).not.toHaveBeenCalled();
  });

  test('a terminal-only session creates a navigator to host customization', () => {
    const terminal = win(1, 'terminal');
    const deps = harness(terminal, [terminal]);

    openSettingsSurface(terminal, deps);

    expect(deps.showNavigator).toHaveBeenCalledExactlyOnceWith(null);
    expect(deps.openNavigator).toHaveBeenCalledOnce();
  });

  test('account settings target an editor even when the navigator is focused', () => {
    const editor = win(1, 'editor');
    const navigator = win(2, 'navigator');
    const deps = harness(navigator, [navigator, editor]);

    openSettingsSurface(navigator, deps, { editorOnly: true, section: 'account' });

    expect(deps.showEditor).toHaveBeenCalledExactlyOnceWith(editor, 'account');
    expect(deps.showNavigator).not.toHaveBeenCalled();
  });

  test('account settings without an editor open the project picker', () => {
    const deps = harness(null, []);

    openSettingsSurface(null, deps, { editorOnly: true, section: 'account' });

    expect(deps.openNavigator).toHaveBeenCalledOnce();
    expect(deps.showEditor).not.toHaveBeenCalled();
    expect(deps.showNavigator).not.toHaveBeenCalled();
    expect(deps.onEditorRequired).toHaveBeenCalledExactlyOnceWith(null);
  });

  test.each(['terminal', 'note', 'navigator'] as const)(
    'account settings explain the project requirement when only a %s is open',
    (kind) => {
      const focused = win(1, kind);
      const deps = harness(focused, [focused]);

      openSettingsSurface(focused, deps, { editorOnly: true, section: 'account' });

      expect(deps.openNavigator).toHaveBeenCalledOnce();
      expect(deps.onEditorRequired).toHaveBeenCalledExactlyOnceWith(focused);
      expect(deps.showNavigator).not.toHaveBeenCalled();
      expect(deps.showEditor).not.toHaveBeenCalled();
    },
  );

  test('does not create an empty navigator when customization cannot be armed', () => {
    const deps = harness(null, []);
    deps.showNavigator.mockReturnValue(false);

    openSettingsSurface(null, deps);

    expect(deps.showNavigator).toHaveBeenCalledExactlyOnceWith(null);
    expect(deps.openNavigator).not.toHaveBeenCalled();
  });

  test.each([null, win(1, 'navigator'), win(2, 'terminal')] as const)(
    'a deep link with %j focused opens the navigator without forcing consent',
    (focused) => {
      const deps = harness(focused, focused ? [focused] : []);

      openSettingsSurface(focused, deps, { origin: 'deep-link' });

      expect(deps.openNavigator).toHaveBeenCalledOnce();
      expect(deps.showNavigator).not.toHaveBeenCalled();
      expect(deps.onEditorRequired).not.toHaveBeenCalled();
    },
  );

  test('a deep link still opens full settings in an existing editor', () => {
    const editor = win(1, 'editor');
    const deps = harness(editor, [editor]);

    openSettingsSurface(editor, deps, { origin: 'deep-link' });

    expect(deps.showEditor).toHaveBeenCalledExactlyOnceWith(editor, undefined);
    expect(deps.showNavigator).not.toHaveBeenCalled();
    expect(deps.openNavigator).not.toHaveBeenCalled();
  });
});

describe('settingsHash', () => {
  test('defaults to the bare settings hash', () => {
    expect(settingsHash()).toBe('#settings');
    expect(settingsHashScript()).toBe('window.location.hash = "#settings"; undefined');
  });

  test('appends a section id', () => {
    expect(settingsHash('account')).toBe('#settings/account');
    expect(settingsHashScript('account')).toBe(
      'window.location.hash = "#settings/account"; undefined',
    );
  });
});
