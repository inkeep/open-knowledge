import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WorkingAvatar } from './WorkingAvatar';
import { FALLBACK_SKIN_PATH, FALLBACK_STROKE_WIDTH } from './working-avatar-shapes';

afterEach(cleanup);

function renderAvatar(status = 'Sharpening a sentence') {
  const { container } = render(<WorkingAvatar status={status} testId="working" />);
  return {
    container,
    svg: container.querySelector('svg') as SVGSVGElement,
    skin: container.querySelector('path') as SVGPathElement,
    eyes: container.querySelectorAll('.ok-working-eye'),
    label: screen.getByText(status),
  };
}

describe('WorkingAvatar', () => {
  test('shows the status text it was handed', () => {
    renderAvatar();
    expect(screen.getByText('Sharpening a sentence')).toBeTruthy();
  });

  test('renders the mascot with a face', () => {
    const { eyes } = renderAvatar();
    expect(eyes).toHaveLength(2);
  });

  test('remounts the status line when the text changes so the swap animates', () => {
    const { container, rerender } = render(<WorkingAvatar status="Reading…" testId="working" />);
    const first = container.querySelector('.ok-working-status');
    rerender(<WorkingAvatar status="Drafting…" testId="working" />);
    const second = container.querySelector('.ok-working-status');
    expect(second?.textContent).toBe('Drafting…');
    expect(second).not.toBe(first);
  });

  test('keeps the swap fade and the shimmer on separate elements', () => {
    const { container } = renderAvatar('Reading…');
    const swap = container.querySelector('.ok-working-status');
    expect(swap?.className).not.toContain('shimmer');
    expect(swap?.querySelector('.shimmer')?.textContent).toBe('Reading…');
  });

  test('the mascot is hidden from assistive tech — the status text carries it', () => {
    const { svg, label } = renderAvatar();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(label.getAttribute('aria-hidden')).toBeNull();
  });

  test('falls back to the static pose where SVG paths cannot be measured', () => {
    const { skin } = renderAvatar();
    expect(skin.getAttribute('d')).toBe(FALLBACK_SKIN_PATH);
  });

  test('announces the working state to screen readers', async () => {
    const { container } = render(<WorkingAvatar status="Thinking…" testId="working" />);
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.className).toContain('sr-only');
    await waitFor(() => expect(region.textContent?.trim()).not.toBe(''));
  });

  test('does not announce the rotating line itself', async () => {
    const { container } = render(<WorkingAvatar status="Thinking…" testId="working" />);
    const region = container.querySelector('[role="status"]') as HTMLElement;
    await waitFor(() => expect(region.textContent?.trim()).not.toBe(''));
    expect(region.textContent).not.toContain('Thinking…');
    expect(container.querySelector('.ok-working-status')?.closest('[role="status"]')).toBeNull();
  });

  test('reduced motion pins the mascot to its resting pose', () => {
    const mq = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    try {
      const { container } = render(<WorkingAvatar status="Thinking…" testId="working" />);
      const skin = container.querySelector('path') as SVGPathElement;
      expect(skin.getAttribute('d')).toBe(FALLBACK_SKIN_PATH);
      expect(Number(skin.getAttribute('stroke-width'))).toBeCloseTo(FALLBACK_STROKE_WIDTH, 2);
      expect(container.querySelector('g > g')?.getAttribute('transform')).toBeNull();
    } finally {
      mq.mockRestore();
    }
  });
});
