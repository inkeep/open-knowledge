import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearActiveThread,
  emitOpenThread,
  getActiveThread,
  setActiveThread,
  subscribeActiveThread,
} from './store';

beforeEach(() => {
  setActiveThread(null);
  emitOpenThread(null);
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
    clearActiveThread('a');
    expect(getActiveThread()).toBe('b');
  });

  it('keeps the open thread active underneath the pointer', () => {
    emitOpenThread('p');
    expect(getActiveThread()).toBe('p');
    setActiveThread('a');
    expect(getActiveThread()).toBe('a');
    clearActiveThread('a');
    expect(getActiveThread()).toBe('p');
    emitOpenThread(null);
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
