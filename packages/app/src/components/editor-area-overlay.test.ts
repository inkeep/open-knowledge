import { describe, expect, test } from 'bun:test';
import { shouldPaintOverlay } from './editor-area-overlay';

/**
 * Pin the 4-state truth table for the warm-reopen bypass conjunction.
 * The AND is load-bearing — flipping to OR would skip the overlay on
 * partially-resolved state, exposing the user to a brief stale-content
 * flash before sync completes.
 */
describe('shouldPaintOverlay', () => {
  describe('skip conditions (overlay does NOT paint)', () => {
    test('returns false when activeDocName is null', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: null,
          deferredActiveDocName: null,
          mountResolved: false,
          syncResolved: false,
        }),
      ).toBe(false);
    });

    test('returns false when active === deferred (no gap)', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: 'a',
          mountResolved: false,
          syncResolved: false,
        }),
      ).toBe(false);
    });

    test('returns false when both promises resolved (warm-reopen bypass)', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: 'b',
          mountResolved: true,
          syncResolved: true,
        }),
      ).toBe(false);
    });
  });

  describe('paint conditions — partial resolution states (the AND is load-bearing)', () => {
    test('mount resolved, sync NOT resolved → paint (regression guard for &&-vs-|| flip)', () => {
      // If a future refactor changes `mountResolved && syncResolved` to
      // `mountResolved || syncResolved`, this case would incorrectly skip
      // the overlay — the user would see the previous doc's editor while
      // sync still pends, then a content snap when sync lands.
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: 'b',
          mountResolved: true,
          syncResolved: false,
        }),
      ).toBe(true);
    });

    test('mount NOT resolved, sync resolved → paint (regression guard for &&-vs-|| flip)', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: 'b',
          mountResolved: false,
          syncResolved: true,
        }),
      ).toBe(true);
    });

    test('neither resolved → paint (cold mount path)', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: 'b',
          mountResolved: false,
          syncResolved: false,
        }),
      ).toBe(true);
    });
  });

  describe('null deferred (initial-load edge cases)', () => {
    test('active set, deferred null, neither resolved → paint', () => {
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: null,
          mountResolved: false,
          syncResolved: false,
        }),
      ).toBe(true);
    });

    test('active set, deferred null, both resolved → no paint (warm-reopen)', () => {
      // Edge case: deferred-value pre-commit, but caches already have
      // entries (e.g., StrictMode dev double-invoke after a successful
      // mount). Still skip — the deferred commit will land instantly.
      expect(
        shouldPaintOverlay({
          activeDocName: 'a',
          deferredActiveDocName: null,
          mountResolved: true,
          syncResolved: true,
        }),
      ).toBe(false);
    });
  });
});
