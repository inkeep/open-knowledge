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

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KEYBOARD_NAV_PATH = resolve(import.meta.dirname, '../../src/editor/block-ux/keyboard-nav.ts');

/**
 * Match a `try { ... } catch (err) { ... }` block by name of the function or
 * keymap entry that owns it. Returns the catch body's source as a string.
 * Throws when the expected anchor isn't found (a future refactor that
 * relocates the catch would fail the test loud, not silently pass).
 */
function extractCatchBody(source: string, anchor: string): string {
  // Locate the anchor line — function or keymap-property declaration.
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx === -1) {
    throw new Error(`anchor not found in keyboard-nav.ts: "${anchor}"`);
  }
  // Find the first `catch` AFTER the anchor.
  const catchIdx = source.indexOf('catch', anchorIdx);
  if (catchIdx === -1) {
    throw new Error(`no catch block found after anchor "${anchor}"`);
  }
  // Capture from `catch` through the matching closing brace. Naive brace
  // counting works here because the catch bodies don't contain string
  // literals with unbalanced braces.
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
    // Anchor: the function definition line. tryL0NodeSelect is the L0 helper
    // shared across ArrowUp / ArrowDown / ArrowLeft / ArrowRight.
    const body = extractCatchBody(source, 'function tryL0NodeSelect');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain('incrementJsxArrowNodeSelectFailed');
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain('direction:');
    expect(body).toContain("tier: 'L0',");
    expect(body).toContain('reason:');
  });

  test('L2 ArrowUp catch narrows RangeError + emits counter + structured warn with tier:L2', () => {
    // Anchor: the ArrowUp keymap binding inside addKeyboardShortcuts.
    // L0 fires first via `if (tryL0NodeSelect(editor, 'up')) return true;`;
    // the catch we want is the SECOND one in the file (L2 step-between-blocks).
    // The function-name anchor isolates this; the second `catch` after the
    // anchor is the right one because tryL0NodeSelect's catch was already
    // captured by the L0 test above.
    //
    // We anchor on the L2 path's structural marker: the comment
    // `// L0 + L2c + L2d + L2: Arrow Up` is stable.
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
    // Anchor: the L2c helper definition. tryExitCompoundJsxUp dispatches the
    // exit transaction when ArrowUp fires from the first inline position of
    // a compound jsxComponent's first descendant block. Its catch must follow
    // the same discipline as L0 / L2 (RangeError narrow + counter + structured
    // warn) per precedent #48.
    const body = extractCatchBody(source, 'function tryExitCompoundJsxUp');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain("incrementJsxArrowNodeSelectFailed('up')");
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain("direction: 'up'");
    expect(body).toContain("tier: 'L2c',");
    expect(body).toContain('reason:');
  });

  test('L2d tryEnterCompoundJsx catch narrows RangeError + emits counter + structured warn with tier:L2d', () => {
    // Anchor: the L2d helper definition. tryEnterCompoundJsx is the bare-arrow
    // ENTRY mirror of tryExitCompoundJsxUp (L2c) — it dispatches the descent
    // into a compound jsxComponent body, generalized over all four directions,
    // so its catch carries the runtime `dir` rather than a direction literal.
    // Same RangeError-narrow + counter + structured-warn discipline.
    const body = extractCatchBody(source, 'function tryEnterCompoundJsx');

    expect(body).toContain('err instanceof RangeError');
    expect(body).toContain('incrementJsxArrowNodeSelectFailed(dir)');
    expect(body).toContain("'jsx-component-arrow-node-select-failed'");
    expect(body).toContain('direction: dir,');
    expect(body).toContain("tier: 'L2d',");
    expect(body).toContain('reason:');
  });

  test('every catch in keyboard-nav.ts narrows to RangeError (no bare catch widening)', () => {
    // Defense-in-depth: scan ALL catch blocks in the file and assert each
    // contains `err instanceof RangeError`. A future contributor who adds a
    // new keymap handler with a bare `catch { return false }` (a common
    // mis-pattern that defeats observability) would fail this test even if
    // they didn't touch any of the specific anchors above. Combined with
    // the per-site assertions, this is the floor for "every dispatch
    // failure is observable".
    //
    // The regex matches `catch (...) {` (TypeScript binding form). The
    // implicit-binding form `catch {` (no params, post-TS 4.0) is also
    // matched — and explicitly forbidden by the assertion below because
    // it produces no `err` reference and therefore can't narrow.
    const catchPattern = /catch\s*(?:\(\s*\w+\s*\)\s*)?\{/g;
    const matches = [...source.matchAll(catchPattern)];
    expect(matches.length).toBeGreaterThanOrEqual(5); // L0 + L2 up + L2 down + L2c + L2d

    for (const m of matches) {
      // The 1000-char window after each `catch {` MUST contain
      // `err instanceof RangeError`. The width has comfortable headroom
      // for the comment blocks the L2 catches carry (~700 chars between
      // the opening `catch {` and the narrowing line) without spanning
      // into sibling try/catch blocks (the file has 50+ chars of code
      // between adjacent catch blocks).
      const window = source.slice(m.index ?? 0, (m.index ?? 0) + 1000);
      expect(window).toContain('err instanceof RangeError');
    }
  });
});
