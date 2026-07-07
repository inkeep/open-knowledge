/**
 * globals.css `prefers-reduced-transparency` revert guard.
 *
 * Locks the structural shape of the @media block that reverts the
 * alpha-aware outer canvas to solid backgrounds when the user has
 * enabled macOS System Settings → Accessibility → Display → Reduce
 * transparency. Pairs with the main-side runtime path
 * (`reduced-transparency-handler.ts`) which calls `setVibrancy(null)`
 * on every BrowserWindow — both sides agree on solid surfaces, so
 * the user sees neither vibrancy nor alpha-aware tints.
 *
 * STOP rules guarded here:
 *   - Reverts MUST be scoped to `html.electron-mode` (web mode never
 *     went alpha-aware in the first place; touching its rules would
 *     regress baseline web rendering).
 *   - Reverts MUST NOT touch inner editor surfaces (sidebar-inset,
 *     card, popover, dialog, tooltip-card, --background) — those stay
 *     opaque always; the @media query has no business there.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_PATH = join(__dirname, 'globals.css');
const CSS = readFileSync(CSS_PATH, 'utf-8');

describe('globals.css — prefers-reduced-transparency revert', () => {
  test('declares a @media (prefers-reduced-transparency: reduce) block', () => {
    expect(CSS).toMatch(/@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)\s*\{/);
  });

  test('reverts html.electron-mode to a solid sidebar background', () => {
    expect(CSS).toMatch(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)[\s\S]*?html\.electron-mode\s*\{[\s\S]*?background-color:\s*var\(--sidebar\)/,
    );
  });

  test('reverts html.electron-mode body to a solid sidebar background', () => {
    expect(CSS).toMatch(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)[\s\S]*?html\.electron-mode\s+body\s*\{[\s\S]*?background-color:\s*var\(--sidebar\)/,
    );
  });

  test('reverts the sidebar-wrapper data-slot to a solid sidebar background', () => {
    expect(CSS).toMatch(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)[\s\S]*?html\.electron-mode\s+\[data-slot="sidebar-wrapper"\]\s*\{[\s\S]*?background-color:\s*var\(--sidebar\)/,
    );
  });

  test('reverts the sidebar-inner data-slot to a solid sidebar background', () => {
    expect(CSS).toMatch(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)[\s\S]*?html\.electron-mode\s+\[data-slot="sidebar-inner"\]\s*\{[\s\S]*?background-color:\s*var\(--sidebar\)/,
    );
  });

  test('strips backdrop-filter from dialog and sheet overlays', () => {
    const block = CSS.match(
      /@media \(prefers-reduced-transparency: reduce\) \{[^}]*\[data-slot="dialog-overlay"\][\s\S]*?\}\s*\}/,
    );
    expect(block).not.toBeNull();
    const blockText = block?.[0] ?? '';
    expect(blockText).toContain('[data-slot="dialog-overlay"]');
    expect(blockText).toContain('[data-slot="sheet-overlay"]');
    expect(blockText).toContain('backdrop-filter: none');
    expect(blockText).toContain('-webkit-backdrop-filter: none');
  });
});

describe('globals.css — STOP rule preserved (inner surfaces stay opaque)', () => {
  // Extract the @media block body so STOP-rule assertions only consider
  // text inside the prefers-reduced-transparency block — they're not
  // global "no inner surface ever appears" assertions.
  const blockMatch = CSS.match(
    /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
  );
  const block = blockMatch?.[1] ?? '';

  test('@media block does not touch sidebar-inset', () => {
    // The main canvas (sidebar-inset) is opaque always — vibrancy sits
    // below it, so reduced-transparency has no work to do here.
    expect(block).not.toMatch(/sidebar-inset/);
  });

  test('@media block does not touch --card / --popover / --background', () => {
    // Inner editor surfaces stay opaque under both the alpha-aware
    // electron-mode rules and the reduced-transparency revert.
    expect(block).not.toMatch(/--card\b/);
    expect(block).not.toMatch(/--popover\b/);
    expect(block).not.toMatch(/--background\b/);
  });

  test('@media block does not redeclare --sidebar (no cycle / no shadow)', () => {
    // Overrides target background-color, NOT the --sidebar custom
    // property itself, so there's no self-referential cycle and no
    // theme-token drift.
    expect(block).not.toMatch(/--sidebar\s*:/);
  });
});

describe('globals.css — revert applies only to electron-mode', () => {
  test('@media block does not declare bare html or body rules without electron-mode', () => {
    // Web mode never went alpha-aware (the alpha-aware retrofit scopes to
    // .electron-mode); emitting a bare `html { ... }` rule inside the
    // @media block would regress baseline web rendering for users with
    // reduced-transparency enabled. Locks every revert rule to the
    // electron-mode prefix.
    const blockMatch = CSS.match(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
    );
    const block = blockMatch?.[1] ?? '';
    // Permitted prefix: html.electron-mode (with optional whitespace +
    // descendant selector). Forbidden: bare `html ` / `html {` /
    // `body {` selectors that would cascade into web mode.
    const stripped = block.replace(/html\.electron-mode[^{]*\{[^}]*\}/g, '');
    expect(stripped).not.toMatch(/^\s*html\s*[{ ]/m);
    expect(stripped).not.toMatch(/^\s*body\s*\{/m);
  });
});
