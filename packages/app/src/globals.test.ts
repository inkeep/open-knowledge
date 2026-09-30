import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { OK_TRAILING_AFFORDANCE_CLASS } from './editor/extensions/trailing-affordance.ts';
import {
  REMOTE_CARET_CLASS,
  REMOTE_CARET_HOST_CLASS,
  REMOTE_CARET_LABEL_CLASS,
} from './editor/plugins/remote-carets.ts';

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

describe('globals.css agent-flash placement', () => {
  test('no rule paints an agent write by counting from a document edge', () => {
    expect(src).not.toContain('data-agent-flash-position');
    expect(src).not.toMatch(/\[data-agent-flash-state="editing"\][^{]*nth-(?:last-)?child/);
  });

  test('the trailing affordance no longer needs excluding, because nothing counts children', () => {
    expect(src).not.toContain(`of :not(.${OK_TRAILING_AFFORDANCE_CLASS},`);
  });

  test('the position-accurate inline decoration is what carries the wash', () => {
    expect(src).toMatch(/\.ok-agent-insert-flash\s*\{[^}]*animation:\s*agent-insert-flash/);
  });
});

describe('globals.css remote caret styling', () => {
  test('styles the classes the caret renderer actually applies', () => {
    expect(src).toContain(`.${REMOTE_CARET_CLASS} {`);
    expect(src).toContain(`.${REMOTE_CARET_LABEL_CLASS} {`);
  });

  test('lifts paint containment off the block hosting a caret, or the label is clipped away', () => {
    expect(src).toMatch(
      new RegExp(
        `\\.ok-chunk-wrapper\\.${REMOTE_CARET_HOST_CLASS}\\s*\\{[^}]*content-visibility:\\s*visible`,
      ),
    );
  });

  test('the label is still positioned outside its block, which is what needs the opt-out', () => {
    expect(src).toMatch(
      new RegExp(`\\.${REMOTE_CARET_LABEL_CLASS}\\s*\\{[^}]*top:\\s*calc\\(-100%`),
    );
  });
});
