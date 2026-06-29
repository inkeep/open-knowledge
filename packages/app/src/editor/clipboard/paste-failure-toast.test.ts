
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as actualSonner from 'sonner';

type ToastFn = { error: ReturnType<typeof mock> };
const toastMock: ToastFn = { error: mock(() => {}) };
mock.module('sonner', () => ({ ...actualSonner, toast: toastMock }));

// biome-ignore lint/suspicious/noExplicitAny: test-scoped dynamic import
let mod: any;

beforeEach(async () => {
  toastMock.error.mockClear();
  mod = await import('./paste-failure-toast.ts');
  mod.resetPasteFailureThrottle();
});

afterEach(() => {
  toastMock.error.mockClear();
});

describe('notifyPasteDegraded', () => {
  test('fires a toast on first call within a scope', () => {
    const fired = mod.notifyPasteDegraded('wysiwyg');
    expect(fired).toBe(true);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('throttles a second call in the same scope within the window', () => {
    mod.notifyPasteDegraded('wysiwyg');
    const fired = mod.notifyPasteDegraded('wysiwyg');
    expect(fired).toBe(false);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  test('separate scopes have independent throttle counters', () => {
    const a = mod.notifyPasteDegraded('wysiwyg');
    const b = mod.notifyPasteDegraded('source');
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(toastMock.error).toHaveBeenCalledTimes(2);
  });

  test('custom message is passed through to toast.error', () => {
    mod.notifyPasteDegraded('wysiwyg', 'Paste was too large.');
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const msg = toastMock.error.mock.calls[0]?.[0];
    expect(msg).toBe('Paste was too large.');
  });

  test('default message mentions plain-text degradation', () => {
    mod.notifyPasteDegraded('wysiwyg');
    const msg = toastMock.error.mock.calls[0]?.[0];
    expect(msg).toContain('plain text');
  });

  test('reset clears the throttle so next call fires again', () => {
    mod.notifyPasteDegraded('wysiwyg');
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    mod.resetPasteFailureThrottle();
    mod.notifyPasteDegraded('wysiwyg');
    expect(toastMock.error).toHaveBeenCalledTimes(2);
  });
});
