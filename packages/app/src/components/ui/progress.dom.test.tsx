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
    const { container } = render(
      <Progress value={null} indeterminateFillPercent={30} aria-label="Sending report" />,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    expect(indicatorOf(container).style.transform).toBe('translateX(-70%)');
  });

  test('indeterminate fill is ignored once a real value arrives', () => {
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

    expectVisualClassTokensAbsent(rootClassName, ['bg-muted']);
    expect((rootClassName ?? '').split(/\s+/)).not.toContain('h-1');
  });

  test('a value is scaled by max rather than read as a literal percentage', () => {
    const { container } = render(<Progress value={100} max={200} aria-label="Downloading" />);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('50%');
    expect(indicatorOf(container).style.transform).toBe('translateX(-50%)');
  });

  test('an out-of-range value paints the indeterminate fill Radix falls back to', () => {
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
