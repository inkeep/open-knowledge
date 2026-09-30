// Client-observer keystroke clock (precedent #14)

import { describe, expect, test } from 'vitest';
import { getLastUserKeystroke, markUserTyping } from './observers';

describe('markUserTyping — global keystroke timestamp (US-006)', () => {
  test('getLastUserKeystroke advances on markUserTyping', () => {
    const before = getLastUserKeystroke();
    markUserTyping();
    const after = getLastUserKeystroke();
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });

  test('global timestamp is shared across call sites (no per-doc state)', () => {
    markUserTyping();
    const ts1 = getLastUserKeystroke();
    const wait = Date.now() + 1;
    while (Date.now() < wait) {}
    markUserTyping();
    const ts2 = getLastUserKeystroke();
    expect(ts2).toBeGreaterThan(ts1);
  });
});
