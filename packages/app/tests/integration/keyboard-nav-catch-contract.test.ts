/**
 * Pins the structural contract for L0 + L2 catch sites in `KeyboardNav`
 * (precedent #48). Synthesizing the concurrent CRDT-edit race that
 * produces the `RangeError` is hard to make deterministic without
 * test-only injection hooks in production code (refused under greenfield
 * posture). The STATIC commitments around the catch site are pinnable
 * here as a source-grep meta-test (precedent #20(g)):
 *
 *   - the counter signature `incrementJsxArrowNodeSelectFailed(dir)` is
 *     invoked from every catch site (per-direction observability)
 *   - the structured warn shape carries
 *     `event: 'jsx-component-arrow-node-select-failed'` + `direction`
 *     + `reason` + `tier`
 *   - every catch narrows to `err instanceof RangeError` — bare
 *     `catch { return false }` widening regresses observability and
 *     hides genuine bugs
 *   - the `tier: 'L0' | 'L2' | 'L2c' | 'L2d'` field on the event JSON disambiguates
 *     auto-NodeSelect failures from block-step failures for the same
 *     direction (both tiers can fail with the same direction; the
 *     discriminator lets observability cleanly split them)
 *
 * The test reads `keyboard-nav.ts` as bytes (no module-level import — the
 * goal is structural enforcement, not behavioral). It locates the five
 * catch blocks (L0 tryL0NodeSelect helper, L2 ArrowUp keymap, L2 ArrowDown
 * keymap, L2c tryExitCompoundJsxUp helper, L2d tryEnterCompoundJsx helper)
 * and asserts each carries the required keywords. A reviewer who
 * widens `catch (err)` to a bare catch, or removes the counter call, or
 * strips the structured warn, fails this test — even if every Playwright
 * scenario still passes (because the race condition is rare in CI).
 *
 * Cross-references precedent #20(g) (source-grep STOP-rule pattern),
 * precedent #46 (tri-state predicate), precedent #48 (KeyboardNav as
 * canonical home for block-level keyboard contract).
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
