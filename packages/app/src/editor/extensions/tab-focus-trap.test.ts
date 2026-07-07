/**
 * `TabFocusTrap` structural contract — the four invariants that together
 * keep `Tab` / `Shift-Tab` from cycling page focus out of the editor when
 * the user is editing plain text:
 *
 *   1. Extension `name === 'tabFocusTrap'` — referenced in regressions and
 *      change logs by this exact name.
 *   2. `priority: 1` — load-bearing. Tiptap's keymap chain runs handlers
 *      from HIGHER priority to LOWER and stops on the first `true`.
 *      `ListItem` (priority 100, stock TipTap default) and `Table` /
 *      `TableFidelity` (priority 60) MUST run first so their context-aware
 *      Tab handlers (sink/lift, next cell) take precedence. Bumping this
 *      to 60+ would inappropriately swallow Tab inside lists and tables.
 *   3. Both `Tab` and `Shift-Tab` handlers exist and BOTH return `true`.
 *      Returning `true` tells Tiptap to call `preventDefault` on the
 *      underlying event; the browser then SKIPS its default focus-traversal
 *      action. A `false` return here would re-introduce the focus-escape
 *      bug. Symmetry across Shift is required so reverse-tab is trapped
 *      too.
 *   4. The extension is registered in `sharedExtensions`. The keymap is
 *      load-bearing only if it actually attaches to the editor instance.
 *
 * Why structural and not behavioral: the handlers are constant returns
 * with zero branching, so a behavioral test would just re-assert what a
 * single source-text grep proves. The drift class worth catching is
 * accidental removal / priority bump / typo'd key name — that's structural.
 */

import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from './shared';
import { TabFocusTrap } from './tab-focus-trap';

describe('TabFocusTrap — structural contract', () => {
  test("name is exactly 'tabFocusTrap'", () => {
    expect(TabFocusTrap.name).toBe('tabFocusTrap');
  });

  test('priority is 1 so ListItem (100) + Table (60) run first in the keymap chain', () => {
    // If this drifts upward, Tab inside listItems / table cells would be
    // swallowed by the trap before the intentional sink/lift / next-cell
    // handlers can run. Pin to 1 explicitly — any non-1 value should fail
    // loud so the chain-precedence contract is visible at review time.
    const ext = TabFocusTrap as unknown as { config: { priority: number } };
    expect(ext.config.priority).toBe(1);
  });

  test('binds both Tab and Shift-Tab, each returning true (consume + preventDefault)', () => {
    const ext = TabFocusTrap as unknown as {
      config: { addKeyboardShortcuts: () => Record<string, () => boolean> };
    };
    // Tiptap's `addKeyboardShortcuts` is called with `this` bound to the
    // extension instance at editor-init time; here we invoke the raw
    // factory in a context-less call. The trap's handlers are pure constant
    // returns — no `this` access — so this is safe for the structural
    // assertions below.
    const shortcuts = ext.config.addKeyboardShortcuts.call({} as never);
    expect(Object.keys(shortcuts).sort()).toEqual(['Shift-Tab', 'Tab']);
    expect(shortcuts.Tab()).toBe(true);
    expect(shortcuts['Shift-Tab']()).toBe(true);
  });

  test('registered in sharedExtensions so the keymap actually attaches to the editor', () => {
    // The trap is inert if it never reaches the Editor instance.
    expect(sharedExtensions).toContain(TabFocusTrap);
  });
});
