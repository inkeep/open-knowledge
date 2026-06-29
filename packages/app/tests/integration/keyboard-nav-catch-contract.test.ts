import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEYBOARD_NAV_PATH = resolve(import.meta.dirname, '../../src/editor/block-ux/keyboard-nav.ts');

function extractCatchBody(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`anchor not found in keyboard-nav.ts: "${anchor}"`);
  }
  const catchIdx = source.indexOf('catch', anchorIdx);
  if (catchIdx === -1) {
    throw new Error(`no catch block found after anchor "${anchor}"`);
  }
  const openBrace = source.indexOf('{', catchIdx);
  if (openBrace === -1) {
    throw new Error(`no opening brace after catch for "${anchor}"`);
  }
  let depth = 1;
  let i = openBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(openBrace, i);
}

describe('KeyboardNav catch-path structural contract (precedent #48)', () => {
  const source = readFileSync(KEYBOARD_NAV_PATH, 'utf-8');

  test('L0 tryL0NodeSelect catch narrows RangeError + emits counter + structured warn with tier:L0', () => {
    const body = extractCatchBody(source, 'function tryL0NodeSelect');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain('incrementJsxArrowNodeSelectFailed');
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain('direction:');
    expect(body).toContain("tier: 'L0',");
    expect(body).toContain('reason:');
  });

  test('L2 ArrowUp catch narrows RangeError + emits counter + structured warn with tier:L2', () => {
    const body = extractCatchBody(source, '// L0 + L2c + L2d + L2: Arrow Up');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain("incrementJsxArrowNodeSelectFailed('up')");
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain("direction: 'up'");
    expect(body).toContain("tier: 'L2',");
    expect(body).toContain('reason:');
  });

  test('L2 ArrowDown catch narrows RangeError + emits counter + structured warn with tier:L2', () => {
    const body = extractCatchBody(source, '// L0 + L2d + L2: Arrow Down');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain("incrementJsxArrowNodeSelectFailed('down')");
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain("direction: 'down'");
    expect(body).toContain("tier: 'L2',");
    expect(body).toContain('reason:');
  });

  test('L2c tryExitCompoundJsxUp catch narrows RangeError + emits counter + structured warn with tier:L2c', () => {
    const body = extractCatchBody(source, 'function tryExitCompoundJsxUp');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain("incrementJsxArrowNodeSelectFailed('up')");
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain("direction: 'up'");
    expect(body).toContain("tier: 'L2c',");
    expect(body).toContain('reason:');
  });

  test('L2d tryEnterCompoundJsx catch narrows RangeError + emits counter + structured warn with tier:L2d', () => {
    const body = extractCatchBody(source, 'function tryEnterCompoundJsx');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain('incrementJsxArrowNodeSelectFailed(dir)');
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain('direction: dir,');
    expect(body).toContain("tier: 'L2d',");
    expect(body).toContain('reason:');
  });

  test('every catch in keyboard-nav.ts narrows to RangeError (no bare catch widening)', () => {
    const catchPattern = /catch\s*(?:\(\s*\w+\s*\)\s*)?\{/g;
    const matches = [...source.matchAll(catchPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(5); // L0 + L2 up + L2 down + L2c + L2d

    for (const m of matches) {
      const window = source.slice(m.index ?? 0, (m.index ?? 0) + 1000);
      expect(window).toContain('err instanceof RangeError');
    }
  });
});
