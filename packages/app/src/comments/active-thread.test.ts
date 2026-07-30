import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearActiveThread,
  emitOpenThreadPopover,
  getActiveThread,
  setActiveThread,
  subscribeActiveThread,
} from './store';

beforeEach(() => {
  setActiveThread(null);
  emitOpenThreadPopover(null);
});

describe('active thread', () => {
  it('starts on nothing', () => {
    expect(getActiveThread()).toBeNull();
  });

  it('follows the pointer', () => {
    setActiveThread('a');
    expect(getActiveThread()).toBe('a');
    clearActiveThread('a');
    expect(getActiveThread()).toBeNull();
  });

  it('ignores a stale leave from the card the pointer already left', () => {
    setActiveThread('a');
    setActiveThread('b');
    // 'a' loses the pointer only after 'b' has taken it.
    clearActiveThread('a');
    expect(getActiveThread()).toBe('b');
  });

  it('keeps the open popover active underneath the pointer', () => {
    emitOpenThreadPopover('p');
    expect(getActiveThread()).toBe('p');
    setActiveThread('a');
    expect(getActiveThread()).toBe('a');
    clearActiveThread('a');
    expect(getActiveThread()).toBe('p');
    emitOpenThreadPopover(null);
    expect(getActiveThread()).toBeNull();
  });

  it('notifies subscribers only when the answer changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveThread(listener);
    setActiveThread('a');
    setActiveThread('a');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setActiveThread('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
