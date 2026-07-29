/**
 * Guards the globals `jsdom-preload.ts` backfills.
 *
 * These stubs are invisible when present and produce confusing failures when
 * absent, so each one gets an assertion naming what breaks without it.
 *
 * The `Range` pair is the reason this file exists. jsdom ships
 * `getClientRects` / `getBoundingClientRect` on Element but NOT on Range;
 * ProseMirror's `singleRect` calls them on a Range built by `textRange(...)`
 * (via `coordsAtPos` ← `EditorView.scrollToSelection`). That path runs
 * asynchronously, AFTER the triggering test resolves, so a missing stub does
 * not fail a test — it surfaces as an uncaught exception and vitest exits
 * non-zero while reporting every test passing:
 *
 *     Test Files  259 passed     Tests  2525 passed     Errors  2 errors
 *     TypeError: target.getClientRects is not a function
 *
 * Being a race against worker teardown, it is load-dependent: green locally,
 * red on slower CI runners. A plain "all tests passed" is therefore NOT
 * evidence the backfill is present, which is why it is asserted here rather
 * than left to be noticed.
 *
 * Mounts through RTL and measures a Range over the mounted text — both to
 * honor the Tier-3 filename contract (`dom-test-filename-stop-rule.test.ts`:
 * every `*.dom.test.tsx` is a mount test and must import a value from
 * `@testing-library/react`) and because measuring a Range over real mounted
 * nodes is the shape ProseMirror actually uses.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

describe('jsdom-preload backfills', () => {
  test('a Range over mounted text can be measured (ProseMirror coordsAtPos path)', () => {
    render(<p data-testid="measured">hello world</p>);
    const paragraph = screen.getByTestId('measured');

    // The ProseMirror shape: a Range across a text node, then getClientRects.
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    expect(typeof range.getClientRects).toBe('function');
    expect(typeof range.getBoundingClientRect).toBe('function');

    // Shape must match what jsdom's own Element implementations return in a
    // layout-less DOM, so ProseMirror takes its existing "no geometry" branch:
    // an empty rect list and an all-zero rect. Asserting the VALUES (not just
    // callability) is what keeps a future stub from returning something
    // ProseMirror would treat as a real measurement.
    const rects = range.getClientRects();
    expect(rects.length).toBe(0);

    const rect = range.getBoundingClientRect();
    expect(rect.top).toBe(0);
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });

  test('the other backfills jsdom omits are installed', () => {
    // matchMedia — useThemeBridge queries prefers-reduced-transparency.
    expect(typeof window.matchMedia).toBe('function');
    expect(window.matchMedia('(prefers-reduced-transparency: reduce)').matches).toBe(false);

    // ResizeObserver — Radix Select/Popper collections read it at mount.
    expect(typeof globalThis.ResizeObserver).toBe('function');

    // scrollIntoView — jsdom's throws "not implemented"; Radix/CodeMirror call
    // it on focus.
    expect(typeof HTMLElement.prototype.scrollIntoView).toBe('function');
    expect(() => document.body.scrollIntoView()).not.toThrow();

    // MessageChannel — React 19's scheduler uses it for postTask scheduling.
    expect(typeof globalThis.MessageChannel).toBe('function');
  });
});
