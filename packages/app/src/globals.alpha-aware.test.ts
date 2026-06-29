import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

describe('globals.css alpha-aware retrofit', () => {
  test('html.electron-mode renders the html background as transparent so vibrancy is exposed', () => {
    expect(CSS).toMatch(/html\.electron-mode\s*\{[^}]*background-color\s*:\s*transparent[^}]*\}/);
  });

  test('body in electron-mode renders bg-sidebar alpha-aware via relative-color syntax (preserves single source of truth)', () => {
    expect(CSS).toMatch(
      /html\.electron-mode\s+body\s*\{[^}]*background-color\s*:\s*oklch\(\s*from\s+var\(--sidebar\)\s+l\s+c\s+h\s*\/\s*0?\.\d+\s*\)[^}]*\}/,
    );
  });

  test('[data-slot="sidebar-wrapper"] in electron-mode renders alpha-aware (overrides inset variant has-data: bg-sidebar)', () => {
    expect(CSS).toMatch(
      /html\.electron-mode\s+\[data-slot=["']sidebar-wrapper["']\]\s*\{[^}]*background-color\s*:\s*oklch\(\s*from\s+var\(--sidebar\)\s+l\s+c\s+h\s*\/\s*0?\.\d+\s*\)[^}]*\}/,
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
        /html\.electron-mode[^{]*\{[^}]*oklch\(\s*from\s+var\(--sidebar\)\s+l\s+c\s+h\s*\/\s*(0?\.\d+)\s*\)[^}]*\}/g,
      ),
    ].map((m) => m[1]);
    expect(alphas.length).toBeGreaterThanOrEqual(3);
    const unique = new Set(alphas);
    expect(unique.size).toBe(1);
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

  test('--sidebar token is not redeclared under html.electron-mode (relative-color syntax targets bg-color directly)', () => {
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--sidebar\s*:/);
  });
});
