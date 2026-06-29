import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOW_MIN_SIZE } from './window-min-size.ts';


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
