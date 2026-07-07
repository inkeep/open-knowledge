/**
 * Unit tests for the slash-insert link-edit auto-open flag shared between
 * the "Link" slash command (producer, component-items.tsx) and
 * `InternalLinkPropPanel` (consumer).
 *
 * The flag lives in a module-scope `Set<string>` keyed by mark id: the
 * slash command inserts a `link` mark, flags its id, then activates the
 * prop panel a frame later; the panel consumes the flag on mount to open
 * the URL editor. The per-id key lets two near-simultaneous inserts each
 * claim their own flag without colliding.
 *
 * These tests lock the contract: set stores, consume drains once-per-id,
 * a never-set id returns false, and StrictMode double-mount can't
 * double-consume a single flag. Mirrors `auto-open-flag.test.ts`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetPendingLinkEditForTest,
  consumePendingLinkEdit,
  setPendingLinkEdit,
} from './link-edit-autoopen';

afterEach(() => {
  _resetPendingLinkEditForTest();
});

describe('setPendingLinkEdit / consumePendingLinkEdit', () => {
  test('consume returns true once, false on subsequent calls for the same id', () => {
    setPendingLinkEdit('m5');
    expect(consumePendingLinkEdit('m5')).toBe(true);
    expect(consumePendingLinkEdit('m5')).toBe(false);
  });

  test('consume returns false for a never-set id', () => {
    expect(consumePendingLinkEdit('m42')).toBe(false);
  });

  test('two different ids do not collide', () => {
    setPendingLinkEdit('m10');
    setPendingLinkEdit('m20');
    expect(consumePendingLinkEdit('m10')).toBe(true);
    expect(consumePendingLinkEdit('m10')).toBe(false); // already drained
    expect(consumePendingLinkEdit('m20')).toBe(true);
    expect(consumePendingLinkEdit('m20')).toBe(false);
  });

  test('set is idempotent for the same id (Set semantics)', () => {
    setPendingLinkEdit('m7');
    setPendingLinkEdit('m7');
    setPendingLinkEdit('m7');
    // Only one "open" — consume drains the single entry and subsequent
    // calls see the flag gone.
    expect(consumePendingLinkEdit('m7')).toBe(true);
    expect(consumePendingLinkEdit('m7')).toBe(false);
  });

  test('StrictMode double-consume: a single consume wins and the second sees nothing', () => {
    // The panel's consume effect is keyed on nodeId; StrictMode runs it
    // twice (mount → cleanup → remount). The first invocation drains the
    // flag, the second sees the empty set — so the dialog opens once.
    setPendingLinkEdit('m99');
    expect(consumePendingLinkEdit('m99')).toBe(true);
    expect(consumePendingLinkEdit('m99')).toBe(false);
    // No leaked state — a later insert with a different id sees a clean set.
    setPendingLinkEdit('m100');
    expect(consumePendingLinkEdit('m99')).toBe(false);
    expect(consumePendingLinkEdit('m100')).toBe(true);
  });
});
