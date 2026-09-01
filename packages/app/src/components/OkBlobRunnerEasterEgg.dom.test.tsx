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

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(game()).toBeTruthy();
  });
});

describe('keyboard={false} (crash screens)', () => {
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
