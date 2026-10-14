import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isImeCompositionKey } from './ime-composition.ts';

afterEach(() => {
  cleanup();
});

function keyResult(init: KeyboardEventInit & { keyCode?: number }): boolean {
  const seen = vi.fn((composing: boolean) => composing);
  const { container } = render(<input onKeyDown={(e) => seen(isImeCompositionKey(e))} />);
  fireEvent.keyDown(container.querySelector('input') as HTMLInputElement, init);
  return seen.mock.results[0]?.value as boolean;
}

describe('isImeCompositionKey', () => {
  test('is true while a composition is active', () => {
    expect(keyResult({ key: 'Enter', isComposing: true })).toBe(true);
  });

  test("is true for Safari's confirming Enter (keyCode 229, isComposing false)", () => {
    expect(keyResult({ key: 'Enter', keyCode: 229 })).toBe(true);
  });

  test('is false for an ordinary Enter', () => {
    expect(keyResult({ key: 'Enter', keyCode: 13 })).toBe(false);
  });
});
