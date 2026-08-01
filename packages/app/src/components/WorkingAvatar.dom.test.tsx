/**
 * Behaviour only. Size, colour, spacing and which CSS personality layers are
 * on are tuning knobs — pinning them here just turns a design tweak into a red
 * test. What is worth guarding is the handful of contracts that break
 * *silently*: a status swap that stops animating, a shimmer the cascade eats,
 * and the fallback that keeps a mascot on screen where paths cannot be measured.
 */

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
    // The line rewrites itself several times a turn as the agent moves between
    // tools. Without a fresh node the CSS animation would not replay and the
    // text would hard-cut.
    // Must re-render the SAME instance: rendering a second tree would make
    // `not.toBe` trivially true and the assertion would survive deleting `key`.
    const { container, rerender } = render(<WorkingAvatar status="Reading…" testId="working" />);
    const first = container.querySelector('.ok-working-status');
    rerender(<WorkingAvatar status="Drafting…" testId="working" />);
    const second = container.querySelector('.ok-working-status');
    expect(second?.textContent).toBe('Drafting…');
    expect(second).not.toBe(first);
  });

  test('keeps the swap fade and the shimmer on separate elements', () => {
    // Both are `animation` shorthands, so on one element the cascade would drop
    // whichever lost — and the line would silently stop shimmering.
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
    // jsdom implements neither getTotalLength nor getPointAtLength, so the
    // shape library never builds and the morph loop never starts. The avatar
    // still has to render a real mascot rather than an empty box.
    const { skin } = renderAvatar();
    expect(skin.getAttribute('d')).toBe(FALLBACK_SKIN_PATH);
  });

  test('announces the working state to screen readers', async () => {
    // This shipped once as state with no rendered consumer — the string was
    // computed and thrown away, so the whole announcement was a no-op that
    // nothing caught. Assert the region exists AND carries text.
    const { container } = render(<WorkingAvatar status="Thinking…" testId="working" />);
    const region = container.querySelector('[role="status"]') as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.className).toContain('sr-only');
    await waitFor(() => expect(region.textContent?.trim()).not.toBe(''));
  });

  test('does not announce the rotating line itself', async () => {
    // Twelve synonyms on a 3.5-7s beat: piping those into the live region
    // would narrate cosmetic variation faster than anyone can listen.
    const { container } = render(<WorkingAvatar status="Thinking…" testId="working" />);
    const region = container.querySelector('[role="status"]') as HTMLElement;
    await waitFor(() => expect(region.textContent?.trim()).not.toBe(''));
    expect(region.textContent).not.toContain('Thinking…');
    expect(container.querySelector('.ok-working-status')?.closest('[role="status"]')).toBeNull();
  });

  test('reduced motion pins the mascot to its resting pose', () => {
    // The guard is three DOM writes that only run for reduced-motion users, so
    // nothing else would notice if it were deleted. jsdom cannot run the morph
    // (no path measurement), so this proves the branch fires and writes the
    // resting values — not the mid-turn transition itself.
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
      // A stale eye offset would leave the face sitting off the resting body.
      expect(container.querySelector('g > g')?.getAttribute('transform')).toBeNull();
    } finally {
      mq.mockRestore();
    }
  });
});
