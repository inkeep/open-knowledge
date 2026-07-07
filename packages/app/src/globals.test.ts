/**
 * Source-level guard for the globals.css `:has()` rule that neutralizes
 * Electron `-webkit-app-region: drag` regions while a Radix Popper-based
 * floater is open.
 *
 * macOS hijacks pointer events in drag regions at the OS chrome level — the
 * DOM never sees pointerdown there. Radix Popover / DropdownMenu /
 * ContextMenu rely on document-level pointerdown for outside-click dismissal
 * (they render no overlay, unlike Dialog with its `DialogOverlay`). The rule
 * targets a stable `data-electron-drag` attribute applied at five drag-region
 * sites (`App.tsx`, `EditorHeader.tsx`, `EditorTabs.tsx`, `FileSidebar.tsx`,
 * `NavigatorApp.tsx`).
 *
 * CSS behavior cannot be exercised in jsdom (no `:has()` evaluation against
 * `-webkit-app-region` cascade), so a source-grep guard is the available
 * tier. A Playwright Electron e2e (open Sync popover, click EditorHeader,
 * assert popover closed) is the right follow-up.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_PATH = join(__dirname, 'globals.css');
const src = readFileSync(SRC_PATH, 'utf-8');

describe('globals.css drag-region neutralization (Popper outside-click in Electron)', () => {
  test('declares a `:has()`-gated rule targeting `data-electron-drag`', () => {
    // Without `:has()` browser support the rule would fail to parse and
    // silently drop adjacent declarations; the `@supports selector(:has(*))`
    // gate keeps the entire block opt-in. Pin both pieces so a refactor that
    // drops the @supports gate or the `data-electron-drag` target surfaces here.
    expect(src).toMatch(/@supports\s+selector\(\s*:has\(\*\)\s*\)/);
    expect(src).toMatch(/\[data-electron-drag\]\s*\{\s*-webkit-app-region:\s*no-drag\s*;/);
  });

  test('the rule fires for every Popper-based slot that needs outside-click dismissal', () => {
    // The three Popper-based primitives are the bug's surface area. Tooltips
    // and HoverCards are intentionally excluded — they dismiss on
    // pointerleave (not pointerdown), and keeping drag live during hover
    // preserves the window-drag affordance.
    const requiredSlots = [
      'popover-content',
      'dropdown-menu-content',
      'dropdown-menu-sub-content',
      'context-menu-content',
      'context-menu-sub-content',
    ];
    for (const slot of requiredSlots) {
      expect(src).toContain(`[data-slot="${slot}"][data-state="open"]`);
    }
  });

  test('does not target tooltip- or hover-card slots (drag stays live during hover)', () => {
    // Including these would neutralize the window-drag affordance every
    // time a button tooltip appears on hover — the user would lose the
    // ability to drag the window by the chrome row whenever a tooltip is
    // visible. Tooltips dismiss on pointerleave, not pointerdown, so the
    // Electron drag-region quirk does not affect their dismissal.
    expect(src).not.toMatch(/\[data-slot="tooltip-content"\]/);
    expect(src).not.toMatch(/\[data-slot="hover-card-content"\]/);
  });
});
