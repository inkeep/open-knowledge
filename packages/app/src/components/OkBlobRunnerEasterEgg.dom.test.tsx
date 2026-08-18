import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@/components/OkBlob', () => ({
  OkBlob: ({ size, variant }: { size: number; variant?: string }) => (
    <div data-testid="ok-blob-probe" data-size={String(size)} data-variant={variant ?? 'default'} />
  ),
}));

const resting = () => document.querySelector('[data-slot="ok-blob-runner-easter-egg"]');
const game = () => document.querySelector('[data-slot="ok-blob-runner"]');

describe('OkBlobRunnerEasterEgg', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('shows only the resting mascot — no track, no score, no hint', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg />);

    expect(resting()).toBeTruthy();
    expect(game()).toBeNull();
    expect(screen.getByTestId('ok-blob-probe').dataset.variant).toBe('sleeping');
    // An easter egg that advertises itself is just a feature in a strange place.
    // Asserted on the slot, not the copy: key names render inside `<kbd>` caps,
    // so a text matcher would find nothing whether or not the hint is there.
    expect(document.querySelector('[data-slot="ok-blob-runner-hint"]')).toBeNull();
  });

  test('ArrowUp wakes it', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg />);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(game()).toBeTruthy();
  });

  test('clicking the mascot wakes it', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg />);

    const node = resting();
    if (!node) throw new Error('resting mascot missing');
    fireEvent.pointerDown(node);
    expect(game()).toBeTruthy();
  });

  test('Space wakes it when nothing owns the keyboard', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg />);

    fireEvent.keyDown(window, { key: ' ' });
    expect(game()).toBeTruthy();
  });

  test('Space does NOT wake it while a button holds focus', async () => {
    // The error fallback focuses "Try again" on mount, and Space is that
    // button's activation key. Stealing it would break recovery for exactly
    // the users who cannot click.
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(
      <div>
        <button type="button">Try again</button>
        <OkBlobRunnerEasterEgg />
      </div>,
    );

    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(window, { key: ' ' });
    expect(game()).toBeNull();

    // ArrowUp is still safe, because no control treats it as activation.
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(game()).toBeTruthy();
  });
});

describe('keyboard={false} (crash screens)', () => {
  // On a crash the bug report is the point. The mascot must be reachable,
  // but it must never take a key that Try again or Report might want.
  test('ArrowUp and Space are both ignored', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg keyboard={false} />);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: ' ' });
    expect(game()).toBeNull();
  });

  test('but clicking the mascot still opens it', async () => {
    const { OkBlobRunnerEasterEgg } = await import('./OkBlobRunnerEasterEgg');
    render(<OkBlobRunnerEasterEgg keyboard={false} />);

    const node = resting();
    if (!node) throw new Error('resting mascot missing');
    fireEvent.pointerDown(node);
    expect(game()).toBeTruthy();
  });
});
