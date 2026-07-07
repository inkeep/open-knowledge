/**
 * Source-level guards for the Tailwind alpha-aware retrofit.
 *
 * In Electron mode, ONLY the outer canvas surfaces become alpha-aware so
 * vibrancy material shows through:
 *   - `<html>`: background transparent (overrides FOUC inline `<style>`)
 *   - `<body>`: bg-sidebar becomes alpha-aware
 *   - `[data-slot="sidebar-wrapper"]`: outer canvas backdrop in inset variant
 *   - `[data-slot="sidebar-inner"]`: visible sidebar panel
 *
 * Inner editor surfaces STAY OPAQUE (STOP rule):
 *   - `[data-slot="sidebar-inset"]`: inner main canvas — preserves visual depth cue
 *   - `--card`, `--popover`, `--background` consumers — solid bg
 *
 * In web mode (no `html.electron-mode` class), the rules don't engage and
 * the chrome renders solid — visually unchanged from baseline.
 *
 * Repo convention is no JSDOM/CSS-parser dependency for this concern; CSS
 * runtime behavior is exercised in Playwright via computed-style probes at
 * the Electron host. These source-level regex guards lock the structural
 * choices a future refactor would silently break (e.g. accidentally
 * making `sidebar-inset` alpha-aware regresses the depth-cue contract).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, 'globals.css'), 'utf8');

describe('globals.css alpha-aware retrofit', () => {
  test('html.electron-mode renders the html background as transparent so vibrancy is exposed', () => {
    expect(CSS).toMatch(/html\.electron-mode\s*\{[^}]*background-color\s*:\s*transparent[^}]*\}/);
  });

  test('body in electron-mode renders bg-sidebar alpha-aware via relative-color syntax (preserves single source of truth)', () => {
    // The relative-color syntax (`oklch(from var(--sidebar) l c h / <alpha>)`)
    // reads --sidebar's cascaded value (set in :root / .dark) and produces
    // the alpha-aware tint without duplicating the OKLCH literals. If the
    // theme moves --sidebar's value, body's alpha-aware bg moves with it.
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
    // Capture the alpha values from the three alpha-aware rules and assert
    // they all match. Drift would mean the body and sidebar tint at different
    // saturations — visually inconsistent.
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
    // STOP rule: the inner main canvas is the visual depth cue — it must
    // remain solid `bg-background` even in Electron mode. An alpha-aware
    // override here regresses the depth cue and can expose vibrancy through
    // the editor area (the V-shape Activity-pool unmount catches this).
    expect(CSS).not.toMatch(
      /html\.electron-mode[^{]*\[data-slot=["']sidebar-inset["']\][^{]*\{[^}]*background[^}]*oklch\(\s*from/,
    );
  });

  test('--card / --popover / --background tokens are not redeclared under html.electron-mode', () => {
    // STOP rule: card / popover / dialog / tooltip-card / background tokens
    // stay solid in both light + dark mode in Electron. Redeclaring them
    // under html.electron-mode (light or dark) would break the depth-cue
    // contract.
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--card\s*:/);
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--popover\s*:/);
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--background\s*:/);
  });

  test('--sidebar token is not redeclared under html.electron-mode (relative-color syntax targets bg-color directly)', () => {
    // The retrofit uses `oklch(from var(--sidebar) l c h / 0.85)` at the
    // background-color level — NOT by overriding --sidebar itself. This
    // keeps --sidebar's single source of truth in :root / .dark intact and
    // avoids self-referential cycles in custom-property resolution.
    expect(CSS).not.toMatch(/html\.electron-mode[^{]*\{[^}]*--sidebar\s*:/);
  });
});
