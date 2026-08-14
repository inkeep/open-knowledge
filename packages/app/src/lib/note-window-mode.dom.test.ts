import { afterEach, describe, expect, test } from 'vitest';
import { isNoteWindow } from './note-window-mode.ts';

type OkDesktopStub = { config: { mode: string } };

function stubMode(mode: string | null): void {
  if (mode === null) {
    (window as unknown as { okDesktop?: OkDesktopStub }).okDesktop = undefined;
    return;
  }
  (window as unknown as { okDesktop?: OkDesktopStub }).okDesktop = { config: { mode } };
}

afterEach(() => {
  stubMode(null);
});

describe('isNoteWindow', () => {
  test('is true for a popped-out note window', () => {
    stubMode('note');
    expect(isNoteWindow()).toBe(true);
  });

  test.each(['editor', 'navigator', 'terminal'])('is false for the %s window mode', (mode) => {
    stubMode(mode);
    expect(isNoteWindow()).toBe(false);
  });

  test('is false on the web host, which has no desktop bridge', () => {
    stubMode(null);
    expect(isNoteWindow()).toBe(false);
  });

  test('a partial bridge with no config resolves false instead of throwing', () => {
    // Session-only E2E hosts expose a bridge without the full surface. This is
    // read during render, so a throw takes the whole header down.
    (window as unknown as { okDesktop?: unknown }).okDesktop = {};
    expect(isNoteWindow()).toBe(false);
  });
});
