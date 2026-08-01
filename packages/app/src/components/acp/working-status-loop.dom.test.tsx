import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { THINKING_HOLD_MS, useThinkingLine } from './working-status';

afterEach(cleanup);

/**
 * The idle line rotates on a self-rescheduling timer, which is the shape that
 * most easily turns into a runaway update loop ("Maximum update depth
 * exceeded"). Render counts are asserted so a cascade shows up as an unbounded
 * count rather than a thrown React error a test could swallow.
 */
function Harness({ turnActive, onRender }: { turnActive: boolean; onRender: () => void }) {
  const line = useThinkingLine(turnActive);
  onRender();
  return <span data-testid="line">{line}</span>;
}

/** Past the longest possible hold, so exactly one rotation is guaranteed. */
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
    // The whole point is movement — a timer that fired once and stopped, or one
    // that kept re-picking the same line, would leave a single entry.
    expect(seen.size).toBeGreaterThan(1);
  });

  test('changes line on every rotation rather than sometimes standing still', () => {
    // Pinning the random source makes each hold exactly the minimum, so one
    // advance fires exactly one rotation. Without it, advancing past the
    // maximum hold can fire two — and A→B→A would look like a stall that
    // isn't one.
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
    // Without a per-turn redraw the second turn resumes where the first
    // stopped and opens on the word already on screen.
    //
    // Draw order is load-bearing here: mounting consumes three samples (the
    // lazy initial index, the effect's redraw, the first hold), and each later
    // turn-open consumes two (redraw, hold). Only samples 1 and 3 pick an
    // index, so those are the two that have to differ.
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
    // A parent re-rendering (new message chunks arriving) must not reselect,
    // or the line would flicker faster than it can be read.
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
    // 50 parent renders plus a handful of state-driven ones, nowhere near a loop.
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

/** A parent holding state that the hook's consumer feeds back into — the shape
    that actually produces the runaway loop if the hook is not stable. */
function FeedbackHarness({ onRender }: { onRender: () => void }) {
  const [turns, setTurns] = useState(0);
  const line = useThinkingLine(true);
  onRender();
  // Deliberately hostile: a parent that reacts to the line by updating state.
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
