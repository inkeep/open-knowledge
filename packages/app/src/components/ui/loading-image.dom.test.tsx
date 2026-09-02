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
    expect(screen.queryByTestId('image-loading-skeleton')).toBeNull();

    const overlay = slot.querySelector('[role="img"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains('ok-image-error-placeholder')).toBe(true);
    expect(overlay?.getAttribute('aria-label')).toBe('Image not found: /images/ghost.png');
    expect(overlay?.textContent).toContain('Image not found');
    expect(overlay?.querySelector('.ok-image-error-target')?.textContent).toBe('/images/ghost.png');
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

    rerender(<LoadingImage src="/images/created.png" alt="" targetExistence="exists" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error')).toBeNull();
    expect(screen.queryByTestId('image-loading-skeleton')).not.toBeNull();
    expect(slot.querySelector('img')?.hasAttribute('hidden')).toBe(false);
  });

  test('deleting the target after a successful load breaks to "Image not found"', () => {
    const { container, rerender } = render(
      <LoadingImage src="/images/live.png" alt="" targetExistence="exists" />,
    );
    fireEvent.load(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('image-slot').getAttribute('data-image-error')).toBeNull();

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
