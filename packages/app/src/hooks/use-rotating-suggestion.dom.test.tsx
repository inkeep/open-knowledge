import { act, cleanup, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SUGGESTION_FADE_MS,
  SUGGESTION_HOLD_MS,
  useRotatingSuggestion,
} from './use-rotating-suggestion';

const PHRASES = ['first', 'second', 'third'] as const;

function Probe({ phrases, enabled }: { phrases: readonly string[]; enabled: boolean }) {
  const { text, visible } = useRotatingSuggestion(phrases, enabled);
  return (
    <span data-testid="probe" data-visible={visible ? 'yes' : 'no'}>
      {text}
    </span>
  );
}

function CommitRecorder({ phrases, commits }: { phrases: readonly string[]; commits: string[] }) {
  const { text } = useRotatingSuggestion(phrases, true);
  useLayoutEffect(() => {
    commits.push(text);
  });
  return null;
}

function probe(): HTMLElement {
  return screen.getByTestId('probe');
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function advanceOneCycle(): void {
  advance(SUGGESTION_HOLD_MS);
  advance(SUGGESTION_FADE_MS);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRotatingSuggestion', () => {
  test('holds the first phrase and never advances when disabled', () => {
    vi.useFakeTimers();
    render(<Probe phrases={PHRASES} enabled={false} />);

    expect(probe().textContent).toBe('first');
    expect(probe().dataset.visible).toBe('yes');

    advance(SUGGESTION_HOLD_MS * 4);

    expect(probe().textContent).toBe('first');
    expect(probe().dataset.visible).toBe('yes');
  });

  test('fades out after the hold, then swaps to the next phrase', () => {
    vi.useFakeTimers();
    render(<Probe phrases={PHRASES} enabled />);

    expect(probe().textContent).toBe('first');

    advance(SUGGESTION_HOLD_MS);

    expect(probe().dataset.visible).toBe('no');
    expect(probe().textContent).toBe('first');

    advance(SUGGESTION_FADE_MS);

    expect(probe().dataset.visible).toBe('yes');
    expect(probe().textContent).toBe('second');
  });

  test('wraps back to the first phrase past the end of the list', () => {
    vi.useFakeTimers();
    render(<Probe phrases={PHRASES} enabled />);

    advanceOneCycle();
    advanceOneCycle();

    expect(probe().textContent).toBe('third');

    advanceOneCycle();

    expect(probe().textContent).toBe('first');
  });

  test('never commits a stale-index phrase when the list changes length', () => {
    vi.useFakeTimers();
    const commits: string[] = [];
    const two = ['first', 'second'] as const;
    const view = render(<CommitRecorder phrases={two} commits={commits} />);

    advanceOneCycle();
    expect(commits.at(-1)).toBe('second');

    commits.length = 0;
    view.rerender(<CommitRecorder phrases={PHRASES} commits={commits} />);

    expect(commits).toEqual(['first']);
  });

  test('resumes from the first phrase after the component remounts', () => {
    vi.useFakeTimers();
    const view = render(<Probe phrases={PHRASES} enabled />);

    advanceOneCycle();
    expect(probe().textContent).toBe('second');

    view.unmount();
    render(<Probe phrases={PHRASES} enabled />);

    expect(probe().textContent).toBe('first');
  });

  test('renders empty text for an empty phrase list', () => {
    vi.useFakeTimers();
    render(<Probe phrases={[]} enabled />);

    expect(probe().textContent).toBe('');

    advanceOneCycle();

    expect(probe().textContent).toBe('');
  });
});
