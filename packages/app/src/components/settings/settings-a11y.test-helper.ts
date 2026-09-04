import { screen } from '@testing-library/react';
import { expect } from 'vitest';

export function describedTextOf(controlTestId: string): string {
  const control = screen.getByTestId(controlTestId);
  const describedBy = control.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  return (describedBy as string)
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}
