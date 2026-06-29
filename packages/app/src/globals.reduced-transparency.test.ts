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
  const blockMatch = CSS.match(
    /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
  );
  const block = blockMatch?.[1] ?? '';

  test('@media block does not touch sidebar-inset', () => {
    expect(block).not.toMatch(/sidebar-inset/);
  });

  test('@media block does not touch --card / --popover / --background', () => {
    expect(block).not.toMatch(/--card\b/);
    expect(block).not.toMatch(/--popover\b/);
    expect(block).not.toMatch(/--background\b/);
  });

  test('@media block does not redeclare --sidebar (no cycle / no shadow)', () => {
    expect(block).not.toMatch(/--sidebar\s*:/);
  });
});

describe('globals.css — revert applies only to electron-mode', () => {
  test('@media block does not declare bare html or body rules without electron-mode', () => {
    const blockMatch = CSS.match(
      /@media\s*\(\s*prefers-reduced-transparency:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
    );
    const block = blockMatch?.[1] ?? '';
    const stripped = block.replace(/html\.electron-mode[^{]*\{[^}]*\}/g, '');
    expect(stripped).not.toMatch(/^\s*html\s*[{ ]/m);
    expect(stripped).not.toMatch(/^\s*body\s*\{/m);
  });
});
