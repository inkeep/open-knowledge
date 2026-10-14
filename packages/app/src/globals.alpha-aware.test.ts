import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

function themedDeskSelectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
    const selector = (match[1] ?? '').replace(/:not\(\s*\[data-color-theme\]\s*\)/g, '');
    const body = match[2] ?? '';
    return /\[data-color-theme\b/.test(selector) && /--desk\s*:/.test(body)
      ? [selector.trim()]
      : [];
  });
}

describe('globals.css alpha-aware retrofit', () => {
  test('html.electron-mode renders the html background as transparent so vibrancy is exposed', () => {
    expect(CSS).toMatch(/html\.electron-mode\s*\{[^}]*background-color\s*:\s*transparent[^}]*\}/);
  });

  test('body in electron-mode renders the desk alpha-aware via relative-color syntax (preserves single source of truth)', () => {
    expect(CSS).toMatch(
      /html\.electron-mode\s+body\s*\{[^}]*background-color\s*:\s*oklch\(\s*from\s+var\(--desk\)\s+l\s+c\s+h\s*\/\s*0?\.\d+\s*\)[^}]*\}/,
    );
  });

  test('[data-slot="sidebar-wrapper"] in electron-mode renders the desk alpha-aware (overrides inset variant has-data: bg-desk)', () => {
    expect(CSS).toMatch(
      /html\.electron-mode\s+\[data-slot=["']sidebar-wrapper["']\]\s*\{[^}]*background-color\s*:\s*oklch\(\s*from\s+var\(--desk\)\s+l\s+c\s+h\s*\/\s*0?\.\d+\s*\)[^}]*\}/,
    );
  });

  test('[data-slot="sidebar-inner"] in electron-mode renders alpha-aware (overrides bg-sidebar on the visible sidebar panel)', () => {
    expect(CSS).toMatch(
      /html\.electron-mode\s+\[data-slot=["']sidebar-inner["']\]\s*\{[^}]*background-color\s*:\s*oklch\(\s*from\s+var\(--sidebar\)\s+l\s+c\s+h\s*\/\s*0?\.\d+\s*\)[^}]*\}/,
    );
  });

  test('alpha used for outer canvas is the same value across html / body / sidebar-wrapper / sidebar-inner (no drift)', () => {
    const alphas = [
      ...CSS.matchAll(
        /html\.electron-mode[^{]*\{[^}]*oklch\(\s*from\s+var\(--(?:sidebar|desk)\)\s+l\s+c\s+h\s*\/\s*(0?\.\d+)\s*\)[^}]*\}/g,
      ),
    ].map((m) => m[1]);
    expect(alphas.length).toBeGreaterThanOrEqual(3);
    const unique = new Set(alphas);
    expect(unique.size).toBe(1);
  });
});

describe('globals.css — the desk token follows the active colour theme', () => {
  test('--desk stays relative to the sidebar in light and named dark themes, with a fixed default dark frame', () => {
    const root = CSS.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(root).toMatch(/--desk:\s*oklch\(from var\(--sidebar\)\s+calc\(l - 0\.015\)\s+c\s+h\)/);
    const dark = CSS.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(dark).not.toMatch(/--desk\s*:/);
    expect(CSS).toMatch(
      /html\.dark:not\(\[data-color-theme\]\)\s*\{[^}]*--desk:\s*oklch\(0\.28 0 0\)/,
    );
    expect(themedDeskSelectors(CSS)).toEqual([]);
    expect(themedDeskSelectors('html.dark[data-color-theme="dracula"] { --desk: red; }')).toEqual([
      'html.dark[data-color-theme="dracula"]',
    ]);
  });
});

describe('globals.css — the file list inside the editor card is opaque', () => {
  test('the file list surface inside the editor card is solid --sidebar, after the alpha-aware rule so it wins on desktop', () => {
    const alpha = CSS.search(/html\.electron-mode\s+\[data-slot=["']sidebar-inner["']\]\s*\{/);
    const opaque = CSS.search(
      /html\s+\[data-editor-file-list-slot\]\s+\[data-slot=["']sidebar-inner["']\]\s*\{[^}]*background-color\s*:\s*var\(--sidebar\)\s*;[^}]*\}/,
    );
    expect(alpha).toBeGreaterThan(-1);
    expect(opaque).toBeGreaterThan(alpha);
  });
});

describe('globals.css STOP rule — inner editor surfaces stay opaque', () => {
  test('[data-slot="sidebar-inset"] is NEVER targeted by an alpha-aware electron-mode rule', () => {
    expect(CSS).not.toMatch(
      /html\.electron-mode[^{]*\[data-slot=["']sidebar-inset["']\][^{]*\{[^}]*background[^}]*oklch\(\s*from/,
    );
  });

  test('--card / --popover / --background tokens are not redeclared under html.electron-mode', () => {
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--card\s*:/);
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--popover\s*:/);
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--background\s*:/);
  });

  test('--sidebar and --desk tokens are not redeclared under html.electron-mode (relative-color syntax targets bg-color directly)', () => {
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--sidebar\s*:/);
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--desk\s*:/);
  });
});
