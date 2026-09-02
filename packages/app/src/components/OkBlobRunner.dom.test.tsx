import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

vi.doMock('@/components/OkBlob', () => ({
  OkBlob: ({ size, variant }: { size: number; variant?: string }) => (
    <div data-testid="ok-blob-probe" data-size={String(size)} data-variant={variant ?? 'default'} />
  ),
}));

function root() {
  const node = document.querySelector('[data-slot="ok-blob-runner"]');
  if (!node) throw new Error('runner not rendered');
  return node;
}

function track() {
  const node = document.querySelector('[data-slot="ok-blob-runner-track"]');
  if (!node) throw new Error('track not rendered');
  node.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 400, height: 100, bottom: 100, right: 400 }) as DOMRect;
  return node;
}

function hint() {
  const node = document.querySelector('[data-slot="ok-blob-runner-hint"]');
  if (!node) throw new Error('hint not rendered');
  return node.textContent?.replace(/\s+/g, ' ').trim();
}

const JUMP_BAND_Y = 10;
const DUCK_BAND_Y = 90;

describe('OkBlobRunner', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.removeItem('ok-blob-runner-best');
  });

  test('starts asleep, exactly as the static mascot it replaces', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('sleeping');
    expect(hint()).toBe('Press Space or tap the blob to start');
  });

  test('the play area is decorative and hidden from assistive tech', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    expect(root().getAttribute('aria-hidden')).toBe('true');
  });

  test('poking the play area wakes the blob and starts a run', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    fireEvent.pointerDown(track(), { clientY: JUMP_BAND_Y });

    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('default');
    expect(hint()).toBe('Space to jump · ↓ to duck');
  });

  test('a low-band press ducks the blob, and releasing stands it back up', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    fireEvent.pointerDown(track(), { clientY: JUMP_BAND_Y });
    fireEvent.pointerUp(track());

    const player = () =>
      document.querySelector<HTMLElement>('[data-slot="ok-blob-runner-track"] .origin-bottom');
    const scaleY = () => {
      const m = /scale\([\d.]+,\s*([\d.]+)\)/.exec(player()?.style.transform ?? '');
      return m ? Number(m[1]) : null;
    };

    fireEvent.pointerDown(track(), { clientY: DUCK_BAND_Y });
    await waitFor(() => expect(scaleY()).toBeLessThan(0.75));

    fireEvent.pointerUp(track());
    await waitFor(() => expect(scaleY()).toBeGreaterThan(0.75));
    expect(hint()).toBe('Space to jump · ↓ to duck');
  });

  test('autoStart begins a run without any input', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner autoStart />);

    await waitFor(() => expect(hint()).toBe('Space to jump · ↓ to duck'));
  });

  test('a press in the lower band ducks, and releasing stands the blob back up', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    const { createRunnerState, isDucked, setDucking, startRunner } = await import(
      './ok-blob-runner-logic'
    );
    render(<OkBlobRunner />);

    fireEvent.pointerDown(track(), { clientY: JUMP_BAND_Y });
    fireEvent.pointerUp(track());

    const probe = createRunnerState();
    startRunner(probe);
    setDucking(probe, true);
    expect(isDucked(probe)).toBe(true);

    fireEvent.pointerDown(track(), { clientY: DUCK_BAND_Y });
    fireEvent.pointerUp(track());
    expect(hint()).toBe('Space to jump · ↓ to duck');
  });

  test('anchors the score to the player physically, not logically', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    const { PLAYER_X } = await import('./ok-blob-runner-logic');
    render(<OkBlobRunner />);

    const score = document.querySelector<HTMLElement>('[data-slot="ok-blob-runner-score"]');
    if (!score) throw new Error('score not rendered');
    expectVisualClassTokens(score.className, ['absolute']);
    expect(score.style.left).toBe(`${PLAYER_X}px`);
  });

  test('keeps the anchor with a stored best, which adds a second span', async () => {
    localStorage.setItem('ok-blob-runner-best', '421');
    const { OkBlobRunner } = await import('./OkBlobRunner');
    const { PLAYER_X } = await import('./ok-blob-runner-logic');
    render(<OkBlobRunner />);

    const score = document.querySelector<HTMLElement>('[data-slot="ok-blob-runner-score"]');
    if (!score) throw new Error('score not rendered');
    expect(score.querySelectorAll('span')).toHaveLength(2);
    expect(score.textContent).toContain('0421');
    expect(score.style.left).toBe(`${PLAYER_X}px`);
  });

  test('renders the full obstacle pool up front so no obstacle can go unpainted', async () => {
    const { OkBlobRunner, OBSTACLE_POOL_SIZE } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    const pool = root().querySelectorAll('[data-slot="ok-blob-runner-obstacle"]');
    expect(pool).toHaveLength(OBSTACLE_POOL_SIZE);
  });

  test('reduced motion never starts a run, even on the reveal path', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );

    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner autoStart />);

    expect(document.querySelector('[data-slot="ok-blob-runner-track"]')).toBeNull();
    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('sleeping');
  });

  test('reduced motion gets the static mascot and no game at all', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );

    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('sleeping');
    expect(document.querySelector('[data-slot="ok-blob-runner"]')).toBeNull();
    expect(document.querySelector('[data-slot="ok-blob-runner-hint"]')).toBeNull();
  });
});
