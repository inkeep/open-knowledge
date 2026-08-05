import { describe, expect, test } from 'vitest';
import {
  formatShortcut,
  formatShortcutBindingLabel,
  formatShortcutLabel,
  isEditableShortcutTarget,
  KEYBOARD_SHORTCUTS,
  type KeyboardShortcutId,
  matchesKeyboardShortcut,
  matchesRendererShortcut,
} from './keyboard-shortcuts';

describe('keyboard shortcut registry', () => {
  test('uses unique shortcut ids', () => {
    const ids = KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('formats platform-specific shortcut labels', () => {
    expect(formatShortcut('command-palette', 'mac')).toBe('⌘ K');
    expect(formatShortcut('command-palette', 'windowsLinux')).toBe('Ctrl K');
    expect(formatShortcut('new-item', 'mac')).toBe('⌘ N');
    expect(formatShortcut('new-item', 'windowsLinux')).toBe('Ctrl N');
    expect(formatShortcut('new-folder', 'mac')).toBe('⇧⌘ N');
    expect(formatShortcut('new-folder', 'windowsLinux')).toBe('Ctrl Shift N');
    expect(formatShortcut('file-tree-copy', 'mac')).toBe('⌘ C');
    expect(formatShortcut('file-tree-paste', 'windowsLinux')).toBe('Ctrl V');
    expect(formatShortcut('file-tree-delete', 'mac')).toBe('⌘ Backspace');
    expect(formatShortcut('file-tree-delete', 'windowsLinux')).toBe('Delete');
    expect(formatShortcut('edit-with-ai', 'mac')).toBe('⇧⌘ I');
    expect(formatShortcut('tab-new', 'mac')).toBe('⌘ T');
    expect(formatShortcut('tab-next', 'mac')).toBe('⌃ Tab');
    expect(formatShortcut('tab-previous', 'mac')).toBe('⌃⇧ Tab');
    expect(formatShortcut('tab-reopen-closed', 'mac')).toBe('⇧⌘ T');
    expect(formatShortcut('navigate-back', 'mac')).toBe('⌘ [');
    expect(formatShortcut('navigate-back', 'windowsLinux')).toBe('Alt ←');
    expect(formatShortcut('navigate-forward', 'mac')).toBe('⌘ ]');
    expect(formatShortcut('navigate-forward', 'windowsLinux')).toBe('Alt →');
  });

  test('formats spoken shortcut labels for accessible names', () => {
    expect(formatShortcutLabel('toggle-files-sidebar', 'mac')).toBe('Option Command S');
    expect(formatShortcutLabel('toggle-files-sidebar', 'windowsLinux')).toBe('Control Alt S');
    expect(
      formatShortcutBindingLabel(
        { mac: '⌥⌘ ↑ / ⌥⌘ ↓', windowsLinux: 'Ctrl Alt ↑ / Ctrl Alt ↓' },
        'mac',
      ),
    ).toBe('Option Command Up Arrow or Option Command Down Arrow');
    expect(formatShortcutLabel('source-folding', 'mac')).toBe(
      'Option Command Left Bracket or Option Command Right Bracket',
    );
    expect(formatShortcutLabel('source-folding', 'windowsLinux')).toBe(
      'Control Shift Left Bracket or Control Shift Right Bracket',
    );
    expect(formatShortcutLabel('tab-next', 'mac')).toBe('Control Tab');
    expect(formatShortcutLabel('navigate-back', 'mac')).toBe('Command Left Bracket');
    expect(formatShortcutLabel('navigate-back', 'windowsLinux')).toBe('Alt Left Arrow');
    expect(formatShortcutLabel('navigate-forward', 'mac')).toBe('Command Right Bracket');
    expect(formatShortcutLabel('navigate-forward', 'windowsLinux')).toBe('Alt Right Arrow');
  });

  test('navigation-history accelerators are native-only and never renderer-matched', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: '[' },
        'navigate-back',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 'ArrowLeft' },
        'navigate-back',
        'windowsLinux',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: ']' },
        'navigate-forward',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 'ArrowRight' },
        'navigate-forward',
        'windowsLinux',
      ),
    ).toBe(false);
  });

  test('matches settings shortcut exactly and excludes Alt combinations', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: ',' },
        'settings',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches CmdOrCtrl renderer shortcuts regardless of detected platform', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: true, key: 's', code: 'KeyS' },
        'toggle-files-sidebar',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: true, key: 's', code: 'KeyS' },
        'toggle-files-sidebar',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches new file primary shortcut per platform and browser-safe fallback', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'n', code: 'KeyN' },
        'new-item',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'n', code: 'KeyN' },
        'new-item',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'n', code: 'KeyN' },
        'new-item',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: true, key: 'n', code: 'KeyN' },
        'new-item',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'N', code: 'KeyN' },
        'new-item',
        'mac',
      ),
    ).toBe(false);
  });

  test('new folder shortcut is desktop-only and not handled by renderer matching', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'N', code: 'KeyN' },
        'new-folder',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'N', code: 'KeyN' },
        'new-folder',
        'windowsLinux',
      ),
    ).toBe(false);
  });

  test('formats the terminal-panel shortcut as Cmd/Ctrl + J', () => {
    expect(formatShortcut('toggle-terminal-panel', 'mac')).toBe('⌘ J');
    expect(formatShortcut('toggle-terminal-panel', 'windowsLinux')).toBe('Ctrl J');
  });

  test('matches the terminal-panel shortcut on Cmd+J / Ctrl+J and excludes extra modifiers', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'j' },
        'toggle-terminal-panel',
        'windowsLinux',
      ),
    ).toBe(true);
    // Wrong platform modifier: Ctrl+J on macOS must NOT match (mod is exact).
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
    // Extra Alt / Shift / bare key are all excluded.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches the terminal-panel shortcut on Ctrl+` on both platforms', () => {
    for (const platform of ['mac', 'windowsLinux'] as const) {
      expect(
        matchesKeyboardShortcut(
          { metaKey: false, ctrlKey: true, altKey: false, key: '`', code: 'Backquote' },
          'toggle-terminal-panel',
          platform,
        ),
      ).toBe(true);
    }
    // Cmd+` is macOS window-cycling, never ours — a `mod` matcher would steal it.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: '`', code: 'Backquote' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
    // Bare backtick must keep typing a backtick.
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: '`', code: 'Backquote' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
    // Matching on `code` means a layout whose backtick key emits another
    // character still toggles, and an unrelated key that emits "`" does not.
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: '<', code: 'Backquote' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: '`', code: 'IntlBackslash' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
  });

  test('⌘J stays bindings[0] so the menu-accelerator parity ratchet keeps matching', () => {
    expect(formatShortcut('toggle-terminal-panel', 'mac')).toBe('⌘ J');
    const terminalShortcut = KEYBOARD_SHORTCUTS.find((s) => s.id === 'toggle-terminal-panel');
    expect(terminalShortcut?.bindings.map((binding) => binding.mac)).toEqual(['⌘ J', '⌃ `']);
  });

  test('matchesRendererShortcut drops menu-delivered chords only when a native menu exists', () => {
    const cmdJ = { metaKey: true, ctrlKey: false, altKey: false, key: 'j' };
    const ctrlBacktick = {
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      key: '`',
      code: 'Backquote',
    };
    // Desktop: the View menu accelerator already dispatches ⌘J, so the renderer
    // must ignore it (acting on both would toggle twice) while still owning ⌃`,
    // which has no accelerator and would otherwise be undeliverable on desktop.
    expect(matchesRendererShortcut(cmdJ, 'toggle-terminal-panel', true, 'mac')).toBe(false);
    expect(matchesRendererShortcut(ctrlBacktick, 'toggle-terminal-panel', true, 'mac')).toBe(true);
    // Web: no menu bar, so the renderer owns every binding.
    expect(matchesRendererShortcut(cmdJ, 'toggle-terminal-panel', false, 'mac')).toBe(true);
    expect(matchesRendererShortcut(ctrlBacktick, 'toggle-terminal-panel', false, 'mac')).toBe(true);

    // Windows/Linux: the native CmdOrCtrl+J accelerator resolves to Ctrl+J, so
    // the same menu-vs-renderer split must hold there too — the double-fire
    // guard is not mac-only. ⌃` carries no accelerator on any platform.
    const ctrlJ = { metaKey: false, ctrlKey: true, altKey: false, key: 'j' };
    expect(matchesRendererShortcut(ctrlJ, 'toggle-terminal-panel', true, 'windowsLinux')).toBe(
      false,
    );
    expect(
      matchesRendererShortcut(ctrlBacktick, 'toggle-terminal-panel', true, 'windowsLinux'),
    ).toBe(true);
    expect(matchesRendererShortcut(ctrlJ, 'toggle-terminal-panel', false, 'windowsLinux')).toBe(
      true,
    );
    expect(
      matchesRendererShortcut(ctrlBacktick, 'toggle-terminal-panel', false, 'windowsLinux'),
    ).toBe(true);
  });

  test('formats the toggle-agent-panel shortcut as Cmd/Ctrl + L', () => {
    expect(formatShortcut('toggle-agent-panel', 'mac')).toBe('⌘ L');
    expect(formatShortcut('toggle-agent-panel', 'windowsLinux')).toBe('Ctrl L');
  });

  test('matches toggle-agent-panel on Cmd+L / Ctrl+L and excludes extra modifiers', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'l' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'l' },
        'toggle-agent-panel',
        'windowsLinux',
      ),
    ).toBe(true);
    // Wrong platform modifier: Ctrl+L on macOS must NOT match (mod is exact).
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'l' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    // Shift+Cmd+L stays free for CodeMirror's source-multi-cursor binding.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'l' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    // ⌥⌘L belongs to open-ask-ai, so the bare-⌘L toggle must reject alt.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'l' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'l' },
        'toggle-agent-panel',
        'mac',
      ),
    ).toBe(false);
  });

  test('formats the open-ask-ai shortcut as Shift+Cmd / Ctrl+Shift + L', () => {
    expect(formatShortcut('open-ask-ai', 'mac')).toBe('⇧⌘ L');
    expect(formatShortcut('open-ask-ai', 'windowsLinux')).toBe('Ctrl Shift L');
  });

  // Shift rather than Alt: Ctrl+Alt+L is KDE Plasma's Lock Session alternate,
  // grabbed by kglobalaccel before any renderer listener sees it.
  test('open-ask-ai requires Shift, keeping bare Cmd+L for the agents panel', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: true, key: 'L', code: 'KeyL' },
        'open-ask-ai',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, shiftKey: true, key: 'L', code: 'KeyL' },
        'open-ask-ai',
        'windowsLinux',
      ),
    ).toBe(true);
    // Bare ⌘L is the agents-panel toggle, never this.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: false, key: 'l', code: 'KeyL' },
        'open-ask-ai',
        'mac',
      ),
    ).toBe(false);
    // Shift alone (no Cmd/Ctrl) is not a chord.
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, shiftKey: true, key: 'L', code: 'KeyL' },
        'open-ask-ai',
        'mac',
      ),
    ).toBe(false);
    // The old ⌥⌘L must NOT still fire — it would lock the screen on KDE.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '¬', code: 'KeyL' },
        'open-ask-ai',
        'mac',
      ),
    ).toBe(false);
  });

  test('formats the new-terminal-tab shortcut as Shift+Cmd/Ctrl + J', () => {
    expect(formatShortcut('new-terminal-tab', 'mac')).toBe('⇧⌘ J');
    expect(formatShortcut('new-terminal-tab', 'windowsLinux')).toBe('Ctrl Shift J');
  });

  test('matches new-terminal-tab on Shift+Cmd+J / Ctrl+Shift+J and stays clear of the ⌘J toggle', () => {
    // The chord fires with shift held, on each platform's mod key.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'j' },
        'new-terminal-tab',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'j' },
        'new-terminal-tab',
        'windowsLinux',
      ),
    ).toBe(true);
    // Without shift it is NOT the launch chord (that is the ⌘J toggle).
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'j' },
        'new-terminal-tab',
        'mac',
      ),
    ).toBe(false);
    // Wrong platform modifier: Ctrl+Shift+J on macOS must NOT match (mod is exact).
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'j' },
        'new-terminal-tab',
        'mac',
      ),
    ).toBe(false);
    // The reverse direction of mutual exclusion: Shift+⌘J does not trip the
    // toggle (plain-⌘J-vs-launch is the "Without shift" case above).
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'j' },
        'toggle-terminal-panel',
        'mac',
      ),
    ).toBe(false);
  });

  test('matches tab shortcuts with strict modifiers', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 't' },
        'tab-new',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 't' },
        'tab-new',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 't' },
        'tab-new',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'Tab' },
        'tab-next',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'Tab' },
        'tab-next',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'Tab' },
        'tab-previous',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'T' },
        'tab-reopen-closed',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches command palette on exact Cmd/Ctrl+K only', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'command-palette',
        'windowsLinux',
      ),
    ).toBe(true);
    // ⇧⌘K must NOT open the palette — that chord belongs to CodeMirror's
    // delete-line in source mode.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'k' },
        'command-palette',
        'mac',
      ),
    ).toBe(false);
  });

  test('add-link shares the exact ⌘K chord with the palette and excludes extra modifiers', () => {
    expect(formatShortcut('add-link', 'mac')).toBe('⌘ K');
    expect(formatShortcut('add-link', 'windowsLinux')).toBe('Ctrl K');
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'add-link',
        'windowsLinux',
      ),
    ).toBe(true);
    // Wrong platform modifier: Ctrl+K on macOS must NOT match (mod is exact).
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'k' },
        'add-link',
        'mac',
      ),
    ).toBe(false);
    // One exact chord, two consumers: matching is identical for both ids;
    // routing between them is contextual (capture-phase claim in the editor
    // vs. the palette's window-bubble fallthrough).
    const exactCmdK = { metaKey: true, ctrlKey: false, altKey: false, key: 'k' };
    expect(matchesKeyboardShortcut(exactCmdK, 'add-link', 'mac')).toBe(true);
    expect(matchesKeyboardShortcut(exactCmdK, 'command-palette', 'mac')).toBe(true);
  });

  test('matches source-aware replace shortcuts per platform', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, key: 'f' },
        'replace',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, key: 'h' },
        'replace',
        'windowsLinux',
      ),
    ).toBe(true);
  });

  test('matches find-next and find-previous with strict shift handling', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'g' },
        'find-next',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'g' },
        'find-next',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'g' },
        'find-previous',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches F3 find navigation alternates with strict shift handling', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'F3' },
        'find-next',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, key: 'F3' },
        'find-next',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, key: 'F3' },
        'find-previous',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches find shortcut with Shift held through allowShiftKey', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'f' },
        'find',
        'mac',
      ),
    ).toBe(true);
  });

  test('matches Edit with AI shortcut only with Cmd/Ctrl+Shift+I', () => {
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: 'I' },
        'edit-with-ai',
        'mac',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: 'i' },
        'edit-with-ai',
        'windowsLinux',
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'k' },
        'edit-with-ai',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'i' },
        'edit-with-ai',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: true, shiftKey: true, key: 'i' },
        'edit-with-ai',
        'mac',
      ),
    ).toBe(false);
  });

  test('detects editable shortcut targets', () => {
    expect(isEditableShortcutTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableShortcutTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableShortcutTarget({ tagName: 'BUTTON' })).toBe(false);
  });

  test('formats the mode-switch shortcuts per platform', () => {
    expect(formatShortcut('toggle-editor-mode', 'mac')).toBe('⌥⌘ M');
    expect(formatShortcut('toggle-editor-mode', 'windowsLinux')).toBe('Ctrl Alt M');
    expect(formatShortcut('view-source-at-cursor', 'mac')).toBe('⌥⌘ E');
    expect(formatShortcut('view-source-at-cursor', 'windowsLinux')).toBe('Ctrl Alt E');
  });

  test('registers the mode-switch commands in their shortcut-help categories', () => {
    const byId = new Map(KEYBOARD_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));
    expect(byId.get('toggle-editor-mode')?.category).toBe('general');
    expect(byId.get('view-source-at-cursor')?.category).toBe('wysiwyg');
  });

  test('the mode-switch chords match only their own id across the whole registry', () => {
    // The matcher keys on `code`, so the produced `key` (layout-dependent when
    // Alt is held) is irrelevant here and set only to satisfy the event shape.
    const chords = [
      { id: 'toggle-editor-mode', code: 'KeyM', key: 'm' },
      { id: 'view-source-at-cursor', code: 'KeyE', key: 'e' },
    ] as const;
    for (const chord of chords) {
      const macEvent = {
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        key: chord.key,
        code: chord.code,
      };
      const winEvent = {
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        key: chord.key,
        code: chord.code,
      };
      for (const shortcut of KEYBOARD_SHORTCUTS) {
        // The public array widens `id` to `string`; every runtime value is a
        // registered id, so narrowing it back for the matcher lookup is sound.
        const id = shortcut.id as KeyboardShortcutId;
        expect(matchesKeyboardShortcut(macEvent, id, 'mac')).toBe(id === chord.id);
        expect(matchesKeyboardShortcut(winEvent, id, 'windowsLinux')).toBe(id === chord.id);
      }
    }
  });

  test('the mode toggle requires its Alt modifier so it never steals Cmd+M', () => {
    // Cmd+M (no Alt) is the macOS "minimize window" chord — the toggle must not
    // fire on it, nor on a bare M keypress.
    expect(
      matchesKeyboardShortcut(
        { metaKey: true, ctrlKey: false, altKey: false, key: 'm', code: 'KeyM' },
        'toggle-editor-mode',
        'mac',
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(
        { metaKey: false, ctrlKey: false, altKey: false, key: 'm', code: 'KeyM' },
        'toggle-editor-mode',
        'mac',
      ),
    ).toBe(false);
  });
});
