import { screen } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * The text a screen reader announces as a control's description.
 *
 * Resolves every id in `aria-describedby` and joins them, because the attribute
 * is a space-separated id list: a control described by more than one element is
 * valid, and `getElementById('a b')` would silently return null. Today every
 * settings row points at exactly one description — Radix's Switch and Select
 * do not contribute ids of their own — so the join is a spec-correctness
 * measure, not a workaround for current behavior.
 */
export function describedTextOf(controlTestId: string): string {
  const control = screen.getByTestId(controlTestId);
  const describedBy = control.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  return (describedBy as string)
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}
