import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOW_MIN_SIZE } from './window-min-size.ts';

/**
 * Pure-function test — no Electron bindings touched at module top, so Bun
 * runs it directly. Verifies both that the constants are sane and that
 * `index.ts` actually wires them at the BrowserWindow construction sites
 * (the bug class is "construction site never opted in to Electron's
 * minWidth/minHeight" — the source-text checks catch a regression where
 * the constants exist but get dropped from a constructor).
 */

describe('WINDOW_MIN_SIZE constants', () => {
  test('declares EDITOR with a usable minimum width', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeGreaterThanOrEqual(320);
  });

  test('declares EDITOR with a usable minimum height', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.height).toBeGreaterThanOrEqual(240);
  });

  test('declares NAVIGATOR with a usable minimum width', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.width).toBeGreaterThanOrEqual(320);
  });

  test('declares NAVIGATOR with a usable minimum height', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.height).toBeGreaterThanOrEqual(240);
  });

  test('EDITOR min width is at least as large as NAVIGATOR min width (wider chrome)', () => {
    // Width-only invariant. Height cannot be cross-compared because the two
    // windows have differently-shaped chrome: the Editor's content is
    // horizontal-toolbar-dominated (modest height floor), while the
    // Navigator's empty / first-launch state centers a header + 3-card row
    // and benefits from a taller floor so the centered group can breathe
    // without responsive-layout work.
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeGreaterThanOrEqual(WINDOW_MIN_SIZE.NAVIGATOR.width);
  });

  test('min sizes leave headroom under initial Editor size (1280 x 800)', () => {
    expect(WINDOW_MIN_SIZE.EDITOR.width).toBeLessThan(1280);
    expect(WINDOW_MIN_SIZE.EDITOR.height).toBeLessThan(800);
  });

  test('min sizes leave headroom under initial Navigator size (840 x 600)', () => {
    expect(WINDOW_MIN_SIZE.NAVIGATOR.width).toBeLessThan(840);
    expect(WINDOW_MIN_SIZE.NAVIGATOR.height).toBeLessThan(600);
  });
});

describe('main/index.ts wires BrowserWindow min-size at construction', () => {
  const indexSource = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  test('imports WINDOW_MIN_SIZE from the sibling module', () => {
    expect(indexSource).toMatch(
      /import\s*\{[^}]*\bWINDOW_MIN_SIZE\b[^}]*\}\s*from\s*['"]\.\/window-min-size\.ts?['"]/,
    );
  });

  test('DEFAULT_WIN_OPTS sets minWidth using WINDOW_MIN_SIZE.NAVIGATOR.width', () => {
    const defaultsBlock = indexSource.match(/const DEFAULT_WIN_OPTS[\s\S]*?^};/m);
    expect(defaultsBlock).not.toBeNull();
    expect(defaultsBlock?.[0]).toMatch(/minWidth:\s*WINDOW_MIN_SIZE\.NAVIGATOR\.width/);
  });

  test('DEFAULT_WIN_OPTS sets minHeight using WINDOW_MIN_SIZE.NAVIGATOR.height', () => {
    const defaultsBlock = indexSource.match(/const DEFAULT_WIN_OPTS[\s\S]*?^};/m);
    expect(defaultsBlock).not.toBeNull();
    expect(defaultsBlock?.[0]).toMatch(/minHeight:\s*WINDOW_MIN_SIZE\.NAVIGATOR\.height/);
  });

  // The Editor override assertions are scoped to the Editor factory block via
  // an extract-then-assert pattern (mirrors the DEFAULT_WIN_OPTS
  // approach). Anchoring on `page-title-updated` is the discriminator — that
  // event handler only appears in the Editor's createWindow callback. A
  // global indexSource.match would pass even if the override migrated to a
  // different constructor or appeared in an unrelated comment.
  const editorFactoryBlock = indexSource.match(
    /createWindow:\s*\(opts\)[\s\S]*?page-title-updated[\s\S]*?^\s*\},/m,
  );

  test('Editor BrowserWindow constructor overrides minWidth to WINDOW_MIN_SIZE.EDITOR.width', () => {
    expect(editorFactoryBlock).not.toBeNull();
    expect(editorFactoryBlock?.[0]).toMatch(/minWidth:\s*WINDOW_MIN_SIZE\.EDITOR\.width/);
  });

  test('Editor BrowserWindow constructor overrides minHeight to WINDOW_MIN_SIZE.EDITOR.height', () => {
    expect(editorFactoryBlock).not.toBeNull();
    expect(editorFactoryBlock?.[0]).toMatch(/minHeight:\s*WINDOW_MIN_SIZE\.EDITOR\.height/);
  });
});
