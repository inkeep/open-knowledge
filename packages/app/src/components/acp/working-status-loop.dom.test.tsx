import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { THINKING_HOLD_MS, useThinkingLine } from './working-status';

afterEach(cleanup);

function Harness({ turnActive, onRender }: { turnActive: boolean; onRender: () => void }) {
  const line = useThinkingLine(turnActive);
  onRender();
  return <span data-testid="line">{line}</span>;
}

const PAST_ONE_HOLD = THINKING_HOLD_MS.max + 1;

describe('useThinkingLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('settles in a bounded number of renders when the turn opens', () => {
    const onRender = vi.fn();
    render(<Harness turnActive onRender={onRender} />);
    expect(onRender.mock.calls.length).toBeLessThan(5);
  });

  test('keeps rotating for as long as the turn runs', () => {
    const onRender = vi.fn();
    const { getByTestId } = render(<Harness turnActive onRender={onRender} />);
    const seen = new Set([getByTestId('line').textContent]);
    for (let i = 0; i < 6; i++) {
      act(() => {
        vi.advanceTimersByTime(PAST_ONE_HOLD);
      });
      seen.add(getByTestId('line').textContent);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test('changes line on every rotation rather than sometimes standing still', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { getByTestId } = render(<Harness turnActive onRender={vi.fn()} />);
      let previous = getByTestId('line').textContent;
      for (let i = 0; i < 12; i++) {
        act(() => {
          vi.advanceTimersByTime(THINKING_HOLD_MS.min + 1);
        });
        const current = getByTestId('line').textContent;
        expect(current).not.toBe(previous);
        previous = current;
      }
    } finally {
      vi.mocked(Math.random).mockRestore();
    }
  });

  test('draws a fresh line when a turn opens', () => {
    const samples = [0.5, 0, 0.5, 0.5];
    let draw = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => samples[draw++] ?? 0.5);
    try {
      const { rerender, getByTestId } = render(<Harness turnActive onRender={vi.fn()} />);
      const first = getByTestId('line').textContent;
      rerender(<Harness turnActive={false} onRender={vi.fn()} />);
      rerender(<Harness turnActive onRender={vi.fn()} />);
      expect(getByTestId('line').textContent).not.toBe(first);
    } finally {
      vi.mocked(Math.random).mockRestore();
    }
  });

  test('streamed output does not advance the line — only the clock does', () => {
    const { rerender, getByTestId } = render(<Harness turnActive onRender={vi.fn()} />);
    const before = getByTestId('line').textContent;
    for (let i = 0; i < 20; i++) {
      rerender(<Harness turnActive onRender={vi.fn()} />);
    }
    expect(getByTestId('line').textContent).toBe(before);
  });

  test('schedules nothing while no turn is running', () => {
    const onRender = vi.fn();
    render(<Harness turnActive={false} onRender={onRender} />);
    onRender.mockClear();
    act(() => {
      vi.advanceTimersByTime(PAST_ONE_HOLD * 10);
    });
    expect(onRender).not.toHaveBeenCalled();
  });

  test('a parent that re-renders constantly does not compound', () => {
    const onRender = vi.fn();
    const { rerender } = render(<Harness turnActive onRender={onRender} />);
    for (let i = 0; i < 50; i++) {
      rerender(<Harness turnActive onRender={onRender} />);
    }
    expect(onRender.mock.calls.length).toBeLessThan(70);
  });

  test('rapid turnActive flapping settles instead of compounding', () => {
    const onRender = vi.fn();
    const { rerender } = render(<Harness turnActive onRender={onRender} />);
    for (let i = 0; i < 25; i++) {
      rerender(<Harness turnActive={i % 2 === 0} onRender={onRender} />);
    }
    expect(onRender.mock.calls.length).toBeLessThan(80);
  });
});

function FeedbackHarness({ onRender }: { onRender: () => void }) {
  const [turns, setTurns] = useState(0);
  const line = useThinkingLine(true);
  onRender();
  if (turns === 0) setTurns(1);
  return <span data-testid="line">{`${line}:${turns}`}</span>;
}

describe('useThinkingLine under a state-updating consumer', () => {
  test('a consumer reacting to the line still converges', () => {
    const onRender = vi.fn();
    const { getByTestId } = render(<FeedbackHarness onRender={onRender} />);
    expect(getByTestId('line').textContent).toMatch(/^\d+:1$/);
    expect(onRender.mock.calls.length).toBeLessThan(10);
  });
});
