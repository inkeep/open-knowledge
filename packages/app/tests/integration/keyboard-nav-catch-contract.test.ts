/**
 * Pins the structural contract for `KeyboardNav`'s L0 and L2 catch sites (precedent #48) as a
 * source-grep meta-test (precedent #20(g)): every catch narrows to `RangeError`, calls the
 * per-direction counter, and emits the structured warn with its `tier` discriminator.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commentStates } from '../../../../test-support/strip-comments.test-helper.mjs';

const KEYBOARD_NAV_PATH = resolve(import.meta.dirname, '../../src/editor/block-ux/keyboard-nav.ts');
const CATCH_HEAD_RE = /\bcatch\s*(?:\(\s*\w+\s*\))?\s*\{/g;

function bodyFrom(source: string, openBrace: number): string {
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

function catchHeads(source: string): number[] {
  CATCH_HEAD_RE.lastIndex = 0;
  const heads: number[] = [];
  let match = CATCH_HEAD_RE.exec(source);
  while (match !== null) {
    heads.push(match.index + match[0].length - 1);
    match = CATCH_HEAD_RE.exec(source);
  }
  return heads;
}

function extractCatchBody(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`anchor not found in keyboard-nav.ts: "${anchor}"`);
  }
  const openBrace = catchHeads(source).find((head) => head > anchorIdx);
  if (openBrace === undefined) {
    throw new Error(`no catch block found after anchor "${anchor}"`);
  }
  return bodyFrom(source, openBrace);
}

describe('KeyboardNav catch-path structural contract (precedent #48)', () => {
  const authored = readFileSync(KEYBOARD_NAV_PATH, 'utf-8');
  const states = commentStates(authored, { path: KEYBOARD_NAV_PATH });

  function eachState(assert: (source: string, state: string) => void): void {
    for (const [state, source] of states) assert(source, state);
  }

  test('L0 tryL0NodeSelect catch narrows RangeError + emits counter + structured warn with tier:L0', () => {
    eachState((source, state) => {
      const body = extractCatchBody(source, 'function tryL0NodeSelect');

      expect(body, state).toContain('err instanceof RangeError');
      expect(body, state).toContain('incrementJsxArrowNodeSelectFailed');
      expect(body, state).toContain("'jsx-component-arrow-node-select-failed'");
      expect(body, state).toContain('direction:');
      expect(body, state).toContain("tier: 'L0',");
      expect(body, state).toContain('reason:');
    });
  });

  test('L2 ArrowUp catch narrows RangeError + emits counter + structured warn with tier:L2', () => {
    eachState((source, state) => {
      const body = extractCatchBody(source, 'ArrowUp: ({ editor }) =>');

      expect(body, state).toContain('err instanceof RangeError');
      expect(body, state).toContain("incrementJsxArrowNodeSelectFailed('up')");
      expect(body, state).toContain("'jsx-component-arrow-node-select-failed'");
      expect(body, state).toContain("direction: 'up'");
      expect(body, state).toContain("tier: 'L2',");
      expect(body, state).toContain('reason:');
    });
  });

  test('L2 ArrowDown catch narrows RangeError + emits counter + structured warn with tier:L2', () => {
    eachState((source, state) => {
      const body = extractCatchBody(source, 'ArrowDown: ({ editor }) =>');

      expect(body, state).toContain('err instanceof RangeError');
      expect(body, state).toContain("incrementJsxArrowNodeSelectFailed('down')");
      expect(body, state).toContain("'jsx-component-arrow-node-select-failed'");
      expect(body, state).toContain("direction: 'down'");
      expect(body, state).toContain("tier: 'L2',");
      expect(body, state).toContain('reason:');
    });
  });

  test('L2c tryExitCompoundJsxUp catch narrows RangeError + emits counter + structured warn with tier:L2c', () => {
    eachState((source, state) => {
      const body = extractCatchBody(source, 'function tryExitCompoundJsxUp');

      expect(body, state).toContain('err instanceof RangeError');
      expect(body, state).toContain("incrementJsxArrowNodeSelectFailed('up')");
      expect(body, state).toContain("'jsx-component-arrow-node-select-failed'");
      expect(body, state).toContain("direction: 'up'");
      expect(body, state).toContain("tier: 'L2c',");
      expect(body, state).toContain('reason:');
    });
  });

  test('L2d tryEnterCompoundJsx catch narrows RangeError + emits counter + structured warn with tier:L2d', () => {
    eachState((source, state) => {
      const body = extractCatchBody(source, 'function tryEnterCompoundJsx');

      expect(body, state).toContain('err instanceof RangeError');
      expect(body, state).toContain('incrementJsxArrowNodeSelectFailed(dir)');
      expect(body, state).toContain("'jsx-component-arrow-node-select-failed'");
      expect(body, state).toContain('direction: dir,');
      expect(body, state).toContain("tier: 'L2d',");
      expect(body, state).toContain('reason:');
    });
  });

  test('every catch in keyboard-nav.ts narrows to RangeError (no bare catch widening)', () => {
    eachState((source, state) => {
      const heads = catchHeads(source);
      expect(heads.length, state).toBeGreaterThanOrEqual(5);

      for (const head of heads) {
        expect(bodyFrom(source, head), state).toContain('err instanceof RangeError');
      }
    });
  });
});
