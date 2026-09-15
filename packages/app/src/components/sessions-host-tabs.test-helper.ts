import { act, screen } from '@testing-library/react';

export function tabTitles(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '');
}

export function focusFirstTab() {
  const tab = screen.getAllByRole('tab')[0] as HTMLElement | undefined;
  if (tab == null) throw new Error('no tab to focus');
  act(() => {
    tab.focus();
  });
}

export function dispatchReorderChord(key: 'ArrowLeft' | 'ArrowRight'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    shiftKey: true,
    cancelable: true,
    bubbles: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

export function dispatchTabChord(digit: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: digit,
    metaKey: true,
    cancelable: true,
    bubbles: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}
