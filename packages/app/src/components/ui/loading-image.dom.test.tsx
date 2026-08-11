/**
 * Behavioral tests for LoadingImage's target-existence-aware placeholder
 * contract. Existence is supplied directly via the `targetExistence` prop
 * (the WYSIWYG oracle wiring is exercised separately in Image.dom.test.tsx),
 * so every case here is a deterministic pin on the presentation state machine:
 * proven-absent → "Image not found"; present/unknown display failure → "Image
 * couldn't be displayed"; heal on target creation; break on target deletion;
 * clipboard/DOM fidelity of the hidden authored <img>.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LoadingImage } from './loading-image';

describe('LoadingImage — truthful placeholders', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('proven-missing target shows "Image not found" without a load attempt', () => {
    render(<LoadingImage src="/images/ghost.png" alt="" targetExistence="missing" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBe('true');
    expect(slot.getAttribute('data-image-error-kind')).toBe('not-found');
    // No load event fired — the placeholder is authoritative from the oracle,
    // and the skeleton is not left announcing forever.
    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    const overlay = slot.querySelector('[role="img"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains('ok-image-error-placeholder')).toBe(true);
    expect(overlay?.getAttribute('aria-label')).toBe('Image not found: /images/ghost.png');
    expect(overlay?.textContent).toContain('Image not found');
    expect(overlay?.querySelector('.ok-image-error-target')?.textContent).toBe('/images/ghost.png');
    // Non-color cue: an icon accompanies the text (aria-hidden so it isn't
    // announced twice), so the state is not conveyed by color alone.
    expect(overlay?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  test('present target that fails to display says "couldn\'t be displayed", not absent', () => {
    const { container } = render(
      <LoadingImage src="/images/corrupt.png" alt="" targetExistence="exists" />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    const overlay = slot.querySelector('[role="img"]');
    expect(overlay?.classList.contains('ok-image-error-placeholder')).toBe(true);
    expect(overlay?.getAttribute('aria-label')).toBe(
      "Image couldn't be displayed: /images/corrupt.png",
    );
    expect(overlay?.querySelector('.ok-image-error-target')?.textContent).toBe(
      '/images/corrupt.png',
    );
    expect(overlay?.textContent).toContain("Image couldn't be displayed");
    expect(overlay?.textContent).not.toContain('not found');
  });

  test('unknown existence never claims absence on a load failure', () => {
    // Default targetExistence is 'unknown' (no oracle / off-project src). A
    // failure must read as "couldn't be displayed", not "not found".
    const { container } = render(<LoadingImage src="https://cdn.example.com/x.png" alt="" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    expect(slot.querySelector('[role="img"]')?.textContent).toContain("couldn't be displayed");
  });

  test('present target that loads renders the image with no placeholder', () => {
    const { container } = render(
      <LoadingImage src="/images/cat.png" alt="a cat" targetExistence="exists" />,
    );
    fireEvent.load(container.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    expect(slot.querySelector('[role="img"]')).toBeNull();
    const img = slot.querySelector('img');
    expect(img?.hasAttribute('hidden')).toBe(false);
    expect(img?.getAttribute('src')).toBe('/images/cat.png');
  });

  test('creating the target heals "not found" back to a fresh load', () => {
    const { rerender } = render(
      <LoadingImage src="/images/created.png" alt="" targetExistence="missing" />,
    );
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBe('true');

    // Target created on disk → oracle flips missing → exists.
    rerender(<LoadingImage src="/images/created.png" alt="" targetExistence="exists" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    // Remounted to re-request: skeleton returns until the fresh load resolves,
    // and the img is visible again (not hidden).
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
    expect(slot.querySelector('img')?.hasAttribute('hidden')).toBe(false);
  });

  test('deleting the target after a successful load breaks to "Image not found"', () => {
    const { container, rerender } = render(
      <LoadingImage src="/images/live.png" alt="" targetExistence="exists" />,
    );
    fireEvent.load(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBeNull();

    // Target deleted on disk → oracle flips exists → missing, over the loaded
    // bitmap.
    rerender(<LoadingImage src="/images/live.png" alt="" targetExistence="missing" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('not-found');
    expect(slot.querySelector('[role="img"]')?.textContent).toContain('Image not found');
    expect(slot.querySelector('img')?.hasAttribute('hidden')).toBe(true);
  });

  test('placeholder chrome is clipboard-opt-out while the hidden <img> keeps the authored src', () => {
    render(<LoadingImage src="/images/ghost.png" alt="" targetExistence="missing" />);
    const slot = screen.getByTestId('image-slot');

    const optOut = slot.querySelector('[data-clipboard-omit="true"]');
    expect(optOut).not.toBeNull();
    expect(optOut?.textContent).toContain('Image not found');
    const img = slot.querySelector('img');
    expect(img?.getAttribute('data-clipboard-omit')).toBeNull();
    expect(img?.hasAttribute('hidden')).toBe(true);
    expect(img?.getAttribute('src')).toBe('/images/ghost.png');
  });

  test('a non-decorative alt is used as the accessible target context', () => {
    render(<LoadingImage src="/images/ghost.png" alt="team photo" targetExistence="missing" />);
    expect(
      screen.getByTestId('image-slot').querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('Image not found: team photo');
  });
});
