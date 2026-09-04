import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RAGE_STREAK_TO_REVEAL } from '@/components/ok-blob-runner-logic';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@/components/OkBlob', () => ({
  OkBlob: ({
    celebrateSignal,
    size,
    onRage,
  }: {
    celebrateSignal: number;
    size: number;
    onRage?: () => void;
  }) => (
    <button
      type="button"
      data-testid="ok-blob-probe"
      data-celebrate-signal={String(celebrateSignal)}
      data-size={String(size)}
      data-has-rage={String(onRage !== undefined)}
      onClick={() => onRage?.()}
    />
  ),
}));

describe('EmptyStateHeader runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports EmptyStateHeader component', async () => {
    const mod = await import('./EmptyStateHeader');
    expect(typeof mod.EmptyStateHeader).toBe('function');
  });

  test('renders title, optional subtitle, block-level row layout, and blob signal', async () => {
    const { EmptyStateHeader } = await import('./EmptyStateHeader');

    const { rerender } = render(
      <EmptyStateHeader title="Choose a starter" subtitle="Pick one" celebrateSignal={3} />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Choose a starter' })).toBeTruthy();
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-celebrate-signal')).toBe('3');
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-size')).toBe('64');

    const root = screen.getByTestId('ok-blob-probe').parentElement;
    expectVisualClassTokens(root?.className, [
      'flex',
      'flex-col',
      'items-start',
      'gap-3',
      '@md/emptystate:flex-row',
      '@md/emptystate:items-center',
      '@md/emptystate:gap-4',
    ]);
    expectVisualClassTokensAbsent(root?.className, ['inline-flex']);

    rerender(<EmptyStateHeader title="Choose a starter" celebrateSignal={4} />);

    expect(screen.queryByText('Pick one')).toBeNull();
    expect(screen.getByTestId('ok-blob-probe').getAttribute('data-celebrate-signal')).toBe('4');
  });
});

describe('EmptyStateHeader rage-streak reveal gate', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function mount(onRageStreak?: () => void) {
    const { EmptyStateHeader } = await import('./EmptyStateHeader');
    render(<EmptyStateHeader title="t" celebrateSignal={0} onRageStreak={onRageStreak} />);
    return screen.getByTestId('ok-blob-probe');
  }

  const CLICK_GAP_MS = 500;

  function rage(
    blob: HTMLElement,
    now: { mockReturnValue(value: number): unknown },
    count: number,
    startMs = 0,
  ) {
    for (let i = 0; i < count; i++) {
      now.mockReturnValue(startMs + i * CLICK_GAP_MS);
      fireEvent.click(blob);
    }
  }

  test('one burst never reveals — the first sparkle is just a sparkle', async () => {
    const onRageStreak = vi.fn();
    const blob = await mount(onRageStreak);
    fireEvent.click(blob);
    expect(onRageStreak).not.toHaveBeenCalled();
  });

  test('a full streak inside the window reveals, exactly once', async () => {
    const onRageStreak = vi.fn();
    const now = vi.spyOn(performance, 'now');
    const blob = await mount(onRageStreak);

    rage(blob, now, RAGE_STREAK_TO_REVEAL - 1);
    expect(onRageStreak).not.toHaveBeenCalled();

    rage(blob, now, 1, (RAGE_STREAK_TO_REVEAL - 1) * CLICK_GAP_MS);
    expect(onRageStreak).toHaveBeenCalledTimes(1);
  });

  test('a gap longer than the window restarts the streak', async () => {
    const onRageStreak = vi.fn();
    const now = vi.spyOn(performance, 'now');
    const blob = await mount(onRageStreak);

    rage(blob, now, RAGE_STREAK_TO_REVEAL - 1);
    rage(blob, now, 1, 60_000);
    expect(onRageStreak).not.toHaveBeenCalled();
  });

  test('the streak resets after a reveal, so a further burst does not re-fire', async () => {
    const onRageStreak = vi.fn();
    const now = vi.spyOn(performance, 'now');
    const blob = await mount(onRageStreak);

    rage(blob, now, RAGE_STREAK_TO_REVEAL);
    expect(onRageStreak).toHaveBeenCalledTimes(1);

    rage(blob, now, 1, RAGE_STREAK_TO_REVEAL * CLICK_GAP_MS);
    expect(onRageStreak).toHaveBeenCalledTimes(1);
  });

  test('no handler is wired where the surface cannot reveal', async () => {
    const blob = await mount(undefined);
    expect(blob.dataset.hasRage).toBe('false');
    fireEvent.click(blob);
  });
});
