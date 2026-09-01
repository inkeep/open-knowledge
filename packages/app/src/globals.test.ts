import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC_PATH = join(__dirname, 'globals.css');
const src = readFileSync(SRC_PATH, 'utf-8');

describe('globals.css drag-region neutralization (Popper outside-click in Electron)', () => {
  test('declares a `:has()`-gated rule targeting `data-electron-drag`', () => {
    expect(src).toMatch(/@supports\s+selector\(\s*:has\(\*\)\s*\)/);
    expect(src).toMatch(/\[data-electron-drag\]\s*\{\s*-webkit-app-region:\s*no-drag\s*;/);
  });

  test('the rule fires for every Popper-based slot that needs outside-click dismissal', () => {
    const requiredSlots = [
      'popover-content',
      'dropdown-menu-content',
      'dropdown-menu-sub-content',
      'context-menu-content',
      'context-menu-sub-content',
      'select-content',
      'menubar-content',
      'menubar-sub-content',
    ];
    for (const slot of requiredSlots) {
      expect(src).toContain(`[data-slot="${slot}"][data-state="open"]`);
    }
  });

  test('does not target tooltip- or hover-card slots (drag stays live during hover)', () => {
    expect(src).not.toMatch(/\[data-slot="tooltip-content"\]/);
    expect(src).not.toMatch(/\[data-slot="hover-card-content"\]/);
  });
});
