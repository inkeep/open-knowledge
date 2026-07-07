/**
 * Unit tests for the slash-insert auto-open flag shared between
 * `focusInsertedComponent` (producer) and `JsxComponentView` (consumer).
 *
 * The flag lives in a module-scope `Set<number>` keyed by the PM insert
 * position because insertContent + setNodeSelection can dispatch as two
 * separate transactions, and the consuming NodeView mounts before
 * `selected=true` is reflected (the useEffect runs with `selected=true`
 * on the re-render after setNodeSelection). The per-pos key lets two
 * near-simultaneous inserts each claim their own flag without colliding.
 *
 * These tests lock in the contract: setPendingAutoOpen stores, the
 * consume-by-pos path drains once-per-pos, the legacy drain-any path
 * drains exactly one entry, and StrictMode double-mount does not
 * double-consume a single flag.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetPendingAutoOpenForTest,
  consumeAutoOpen,
  setPendingAutoOpen,
} from './component-items';

afterEach(() => {
  _resetPendingAutoOpenForTest();
});

describe('setPendingAutoOpen / consumeAutoOpen', () => {
  test('consumeAutoOpen(pos) returns true once, false on subsequent calls for same pos', () => {
    setPendingAutoOpen(5);
    expect(consumeAutoOpen(5)).toBe(true);
    expect(consumeAutoOpen(5)).toBe(false);
  });

  test('consumeAutoOpen(pos) returns false for a never-set pos', () => {
    expect(consumeAutoOpen(42)).toBe(false);
  });

  test('two different pos values do not collide', () => {
    setPendingAutoOpen(10);
    setPendingAutoOpen(20);
    expect(consumeAutoOpen(10)).toBe(true);
    expect(consumeAutoOpen(10)).toBe(false); // already drained
    expect(consumeAutoOpen(20)).toBe(true);
    expect(consumeAutoOpen(20)).toBe(false);
  });

  test('setPendingAutoOpen is idempotent for the same pos (Set semantics)', () => {
    setPendingAutoOpen(7);
    setPendingAutoOpen(7);
    setPendingAutoOpen(7);
    // Only one "open" — consume drains the single entry and subsequent
    // calls see the flag gone.
    expect(consumeAutoOpen(7)).toBe(true);
    expect(consumeAutoOpen(7)).toBe(false);
  });

  test('consumeAutoOpen() with no arg drains exactly one pending entry (legacy drain path)', () => {
    setPendingAutoOpen(1);
    setPendingAutoOpen(2);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen()).toBe(false);
  });

  test('consumeAutoOpen() with no arg returns false when the set is empty', () => {
    expect(consumeAutoOpen()).toBe(false);
  });

  test('StrictMode double-consume: a single consume wins and the second sees nothing', () => {
    // StrictMode runs every effect twice (mount → cleanup → remount). The
    // consumer's useEffect guard is `wasSelected` + consumeAutoOpen — if
    // the first invocation consumes, the second sees the empty set.
    setPendingAutoOpen(99);
    // First mount effect consumes.
    expect(consumeAutoOpen(99)).toBe(true);
    // StrictMode's second invocation gets nothing.
    expect(consumeAutoOpen(99)).toBe(false);
    // No leaked state — a later insert at a different pos sees a clean set.
    setPendingAutoOpen(100);
    expect(consumeAutoOpen(99)).toBe(false);
    expect(consumeAutoOpen(100)).toBe(true);
  });

  test('legacy drain path does not consume an entry belonging to a specific pos later', () => {
    // Edge case: producer sets pos=30, consumer A does drain-any (legacy
    // path, NodeView has no getPos yet), consumer B (NodeView at pos=30)
    // then calls consumeAutoOpen(30). The legacy consumer A takes the
    // entry first, so B must see empty.
    setPendingAutoOpen(30);
    expect(consumeAutoOpen()).toBe(true);
    expect(consumeAutoOpen(30)).toBe(false);
  });
});
