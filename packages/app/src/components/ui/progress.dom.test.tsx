/**
 * DOM-substrate tests for Progress. The contract that matters here is the split
 * between what the bar *announces* and what it *paints*: upstream shadcn drops
 * `value` before it reaches the Radix root, so a determinate bar silently loses
 * its `aria-valuenow`. These tests pin the forwarding, and pin that a bar can
 * be visually filled while staying honestly indeterminate.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';
import { Progress } from './progress';

afterEach(cleanup);

function indicatorOf(container: HTMLElement): HTMLElement {
  const indicator = container.querySelector<HTMLElement>('[data-slot="progress-indicator"]');
  if (!indicator) throw new Error('Progress rendered no indicator');
  return indicator;
}

describe('Progress', () => {
  test('exposes a progressbar role', () => {
    render(<Progress value={42} aria-label="Downloading" />);

    expect(screen.getByRole('progressbar')).not.toBeNull();
  });

  test('a determinate value reaches the accessibility tree', () => {
    // The reason this primitive diverges from upstream: shadcn destructures
    // `value` and never forwards it, so this attribute would be absent.
    render(<Progress value={42} aria-label="Downloading" />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  });

  test('a determinate value paints the track to that percentage', () => {
    const { container } = render(<Progress value={42} aria-label="Downloading" />);

    expect(indicatorOf(container).style.transform).toBe('translateX(-58%)');
  });

  test('a null value announces nothing rather than an invented number', () => {
    render(<Progress value={null} aria-label="Sending report" />);

    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('data-state')).toBe('indeterminate');
  });

  test('an indeterminate bar still paints the requested fill', () => {
    // A time-eased estimate: the bar moves, but no percentage is claimed.
    const { container } = render(
      <Progress value={null} indeterminateFillPercent={30} aria-label="Sending report" />,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    expect(indicatorOf(container).style.transform).toBe('translateX(-70%)');
  });

  test('indeterminate fill is ignored once a real value arrives', () => {
    // Both call sites pass a constant fallback alongside a live value, so the
    // fallback must never win when the value is measurable.
    const { container } = render(
      <Progress value={90} indeterminateFillPercent={40} aria-label="Downloading" />,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('90');
    expect(indicatorOf(container).style.transform).toBe('translateX(-10%)');
  });

  test('an indeterminate bar with no fill requested stays empty', () => {
    const { container } = render(<Progress value={null} aria-label="Sending report" />);

    expect(indicatorOf(container).style.transform).toBe('translateX(-100%)');
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    const { container } = render(
      <Progress value={10} aria-label="Downloading" className="h-1.5 bg-secondary" />,
    );

    const rootClassName = container.querySelector('[data-slot="progress"]')?.getAttribute('class');

    expectVisualClassTokens(rootClassName, ['rounded-full', 'w-full', 'h-1.5', 'bg-secondary']);

    // Presence alone would still pass if `cn` degenerated to plain `clsx`: both
    // the base and the override would sit in the attribute and source order
    // would silently decide. The displaced tokens have to be gone.
    expectVisualClassTokensAbsent(rootClassName, ['bg-muted']);
    // `h-1` is a prefix of the `h-1.5` that replaced it, so substring absence
    // cannot express this one — the height override needs an exact-token check.
    expect((rootClassName ?? '').split(/\s+/)).not.toContain('h-1');
  });

  test('a value is scaled by max rather than read as a literal percentage', () => {
    // Radix announces `value/max`; painting `value` directly would show a full
    // bar while the accessibility tree said half.
    const { container } = render(<Progress value={100} max={200} aria-label="Downloading" />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('50%');
    expect(indicatorOf(container).style.transform).toBe('translateX(-50%)');
  });

  test('an out-of-range value paints the indeterminate fill Radix falls back to', () => {
    // Radix demotes a value above max to indeterminate. Treating it as a literal
    // percentage would translate the indicator off the right edge of its track.
    // Radix scolds the caller on the way, which is how this test proves it is
    // exercising the demotion rather than passing by coincidence.
    const scold = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { container } = render(
        <Progress value={150} indeterminateFillPercent={40} aria-label="Downloading" />,
      );

      expect(scold).toHaveBeenCalled();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
      expect(indicatorOf(container).style.transform).toBe('translateX(-60%)');
    } finally {
      scold.mockRestore();
    }
  });

  test('an impossible indeterminate fill is clamped to the track', () => {
    const { container } = render(
      <Progress value={null} indeterminateFillPercent={400} aria-label="Sending report" />,
    );

    expect(indicatorOf(container).style.transform).toBe('translateX(-0%)');
  });

  test('the fill transition stands still under prefers-reduced-motion', () => {
    const { container } = render(<Progress value={42} aria-label="Downloading" />);

    expectVisualClassTokens(indicatorOf(container).getAttribute('class'), [
      'transition-all',
      'motion-reduce:transition-none',
    ]);
  });

  test('accepts a visible status line as its accessible name', () => {
    // Preferred over inventing a second string: the name matches what is on
    // screen, and no new copy needs translating.
    render(
      <>
        <span id="status-line">Downloading ripgrep 14.1.0</span>
        <Progress value={25} aria-labelledby="status-line" />
      </>,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-labelledby')).toBe('status-line');
    expect(screen.getByLabelText('Downloading ripgrep 14.1.0')).not.toBeNull();
  });
});
