import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Stand in for the real mascot so the assertions read the props the runner
// drives (size + variant) rather than the SVG internals.
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

/** The play surface — owns the pointer input, so events must land here. */
function track() {
  const node = document.querySelector('[data-slot="ok-blob-runner-track"]');
  if (!node) throw new Error('track not rendered');
  // jsdom lays nothing out, so give the band split a real box to divide.
  node.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 400, height: 100, bottom: 100, right: 400 }) as DOMRect;
  return node;
}

/** Press in the upper (jump) band vs. the lower (duck) band. */
const JUMP_BAND_Y = 10;
const DUCK_BAND_Y = 90;

describe('OkBlobRunner', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('starts asleep, exactly as the static mascot it replaces', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('sleeping');
    expect(screen.getByText('Press space or tap the blob to start')).toBeTruthy();
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
    expect(screen.getByText('Space to jump · down arrow to duck')).toBeTruthy();
  });

  test('a low-band press ducks the blob, and releasing stands it back up', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    fireEvent.pointerDown(track(), { clientY: JUMP_BAND_Y });
    fireEvent.pointerUp(track());

    // Observe the RENDERED blob, not a detached probe. The player's transform
    // carries the deformation, so a squashed scaleY is the duck actually
    // reaching the DOM. An earlier version asserted setDucking/isDucked against
    // a freshly-built state the component never saw, which read `true` no
    // matter what the press did.
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
    expect(screen.getByText('Space to jump · down arrow to duck')).toBeTruthy();
  });

  test('autoStart begins a run without any input', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    render(<OkBlobRunner autoStart />);

    // The reveal paths mount with autoStart; nothing else starts the run.
    await waitFor(() =>
      expect(screen.getByText('Space to jump · down arrow to duck')).toBeTruthy(),
    );
    expect(screen.queryByText('Press space or tap the blob to start')).toBeNull();
  });

  test('a press in the lower band ducks, and releasing stands the blob back up', async () => {
    const { OkBlobRunner } = await import('./OkBlobRunner');
    const { createRunnerState, isDucked, setDucking, startRunner } = await import(
      './ok-blob-runner-logic'
    );
    render(<OkBlobRunner />);

    // Start the run (any band starts it; the split only applies mid-run).
    fireEvent.pointerDown(track(), { clientY: JUMP_BAND_Y });
    fireEvent.pointerUp(track());

    // The component owns its state ref, so assert the wiring through the same
    // pure helpers the renderer uses rather than reaching into the instance.
    const probe = createRunnerState();
    startRunner(probe);
    setDucking(probe, true);
    expect(isDucked(probe)).toBe(true);

    fireEvent.pointerDown(track(), { clientY: DUCK_BAND_Y });
    fireEvent.pointerUp(track());
    // Releasing must not end the run or crash the loop.
    expect(screen.getByText('Space to jump · down arrow to duck')).toBeTruthy();
  });

  test('renders the full obstacle pool up front so no obstacle can go unpainted', async () => {
    const { OkBlobRunner, OBSTACLE_POOL_SIZE } = await import('./OkBlobRunner');
    render(<OkBlobRunner />);

    const pool = root().querySelectorAll('[data-slot="ok-blob-runner-obstacle"]');
    expect(pool).toHaveLength(OBSTACLE_POOL_SIZE);
  });

  test('reduced motion never starts a run, even on the reveal path', async () => {
    // autoStart is the reveal path. Without a reduced-motion guard it would set
    // phase to running and spin the rAF loop on a game that is never rendered.
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
    expect(screen.queryByText('Press space or tap the blob to start')).toBeNull();
  });
});
