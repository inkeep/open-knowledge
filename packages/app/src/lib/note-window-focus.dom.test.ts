import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetNoteWindowFocusClaimForTests,
  claimNoteWindowInitialFocus,
} from './note-window-focus.ts';

type OkDesktopStub = { config: { mode: string } };

function stubMode(mode: string | null): void {
  if (mode === null) {
    (window as unknown as { okDesktop?: OkDesktopStub }).okDesktop = undefined;
    return;
  }
  (window as unknown as { okDesktop?: OkDesktopStub }).okDesktop = { config: { mode } };
}

beforeEach(() => {
  __resetNoteWindowFocusClaimForTests();
});

afterEach(() => {
  stubMode(null);
  __resetNoteWindowFocusClaimForTests();
});

describe('claimNoteWindowInitialFocus', () => {
  test('the first editor surface in a note window takes the caret', () => {
    stubMode('note');
    expect(claimNoteWindowInitialFocus()).toBe(true);
  });

  test('a later mount finds the claim spent, so focus is never yanked back', () => {
    stubMode('note');
    claimNoteWindowInitialFocus();

    expect(claimNoteWindowInitialFocus()).toBe(false);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });

  test.each(['editor', 'navigator', 'terminal'])('the %s window mode never autofocuses', (mode) => {
    stubMode(mode);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });

  test('the web host never autofocuses', () => {
    stubMode(null);
    expect(claimNoteWindowInitialFocus()).toBe(false);
  });

  test('a non-note window does not spend the claim a later note window would need', () => {
    stubMode('editor');
    expect(claimNoteWindowInitialFocus()).toBe(false);

    stubMode('note');
    expect(claimNoteWindowInitialFocus()).toBe(true);
  });
});
