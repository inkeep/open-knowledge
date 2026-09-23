import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SUGGESTION_FADE_MS, SUGGESTION_HOLD_MS } from '@/hooks/use-rotating-suggestion';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { RotatingComposerPlaceholder } from './RotatingComposerPlaceholder';

const PHRASES = ['Message Claude', 'Type @ to mention a page'] as const;

function stubReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia;
  const stub = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.matchMedia = stub;
  (globalThis as { matchMedia?: typeof window.matchMedia }).matchMedia = stub;
  return () => {
    window.matchMedia = original;
    (globalThis as { matchMedia?: typeof window.matchMedia }).matchMedia = original;
  };
}

function phraseOf(node: HTMLElement): string | null {
  return (
    node.querySelector('[data-rotating-placeholder]')?.getAttribute('data-rotating-placeholder') ??
    null
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RotatingComposerPlaceholder', () => {
  test('shows the first phrase and stays hidden from assistive tech', () => {
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    const node = screen.getByTestId('ph');
    expect(phraseOf(node)).toBe('Message Claude');
    expect(node.getAttribute('aria-hidden')).toBe('true');
  });

  test('renders nothing when there are no phrases', () => {
    render(<RotatingComposerPlaceholder phrases={[]} rotating testId="ph" />);

    expect(screen.queryByTestId('ph')).toBeNull();
  });

  test('advances to the next phrase while rotating', () => {
    vi.useFakeTimers();
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    act(() => {
      vi.advanceTimersByTime(SUGGESTION_HOLD_MS);
    });
    act(() => {
      vi.advanceTimersByTime(SUGGESTION_FADE_MS);
    });

    expect(phraseOf(screen.getByTestId('ph'))).toBe('Type @ to mention a page');
  });

  test('holds the single phrase when rotating is off', () => {
    vi.useFakeTimers();
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating={false} testId="ph" />);

    act(() => {
      vi.advanceTimersByTime((SUGGESTION_HOLD_MS + SUGGESTION_FADE_MS) * 3);
    });

    expect(phraseOf(screen.getByTestId('ph'))).toBe('Message Claude');
  });

  test('crossfades under reduced motion rather than blanking between phrases', () => {
    const restore = stubReducedMotion(true);
    vi.useFakeTimers();
    try {
      render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

      expectVisualClassTokens(screen.getByTestId('ph').className, ['transition-opacity']);

      act(() => {
        vi.advanceTimersByTime(SUGGESTION_HOLD_MS);
      });
      act(() => {
        vi.advanceTimersByTime(SUGGESTION_FADE_MS);
      });

      expect(phraseOf(screen.getByTestId('ph'))).toBe('Type @ to mention a page');
    } finally {
      restore();
    }
  });

  test('ellipsizes a phrase wider than the composer', () => {
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    const text = screen.getByTestId('ph').querySelector<HTMLElement>('[data-rotating-placeholder]');
    expect(text?.parentElement).toBe(screen.getByTestId('ph'));
    expectVisualClassTokens(text?.className ?? '', ['block', 'truncate']);
  });

  test('restarts at the first phrase when the phrase list changes length', () => {
    vi.useFakeTimers();
    const view = render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    act(() => {
      vi.advanceTimersByTime(SUGGESTION_HOLD_MS);
    });
    act(() => {
      vi.advanceTimersByTime(SUGGESTION_FADE_MS);
    });
    expect(phraseOf(screen.getByTestId('ph'))).toBe('Type @ to mention a page');

    view.rerender(
      <RotatingComposerPlaceholder
        phrases={[...PHRASES, 'Type / for commands']}
        rotating
        testId="ph"
      />,
    );

    expect(phraseOf(screen.getByTestId('ph'))).toBe('Message Claude');
  });

  test('keeps the phrase out of the DOM text so it matches the editor placeholder tone', () => {
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    const node = screen.getByTestId('ph');
    expect(node.textContent).toBe('');
    expectVisualClassTokens(node.className, ['text-muted-foreground/60']);
  });

  test('paints the phrase from its attribute and lets clicks reach the input', () => {
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    const node = screen.getByTestId('ph');
    const text = node.querySelector<HTMLElement>('[data-rotating-placeholder]');
    expectVisualClassTokens(node.className, ['pointer-events-none']);
    expectVisualClassTokens(text?.className ?? '', [
      'before:content-[attr(data-rotating-placeholder)]',
    ]);
  });

  test('pins the line-height to the composer so text origins align', () => {
    render(<RotatingComposerPlaceholder phrases={PHRASES} rotating testId="ph" />);

    expectVisualClassTokens(screen.getByTestId('ph').className, ['leading-[1.5]']);
  });

  test('merges the caller className onto the overlay', () => {
    render(
      <RotatingComposerPlaceholder
        phrases={PHRASES}
        rotating
        className="px-2.5 pt-2"
        testId="ph"
      />,
    );

    expectVisualClassTokens(screen.getByTestId('ph').className, ['px-2.5']);
  });
});
