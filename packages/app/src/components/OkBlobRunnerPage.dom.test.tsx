import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@/components/OkBlobRunner', () => ({
  OkBlobRunner: ({ autoStart }: { autoStart?: boolean }) => (
    <div data-testid="runner-probe" data-autostart={String(autoStart ?? false)} />
  ),
}));

describe('OkBlobRunnerPage', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('takes focus on mount', async () => {
    // Load-bearing: opening from the Resources menu leaves focus on that menu's
    // trigger (Radix restores it), and the runner's key handler stands down
    // while a control holds focus. Without this, Space reopens the menu instead
    // of starting the game.
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const { OkBlobRunnerPage } = await import('./OkBlobRunnerPage');
    render(<OkBlobRunnerPage />);
    expect(focus).toHaveBeenCalled();
  });

  test('does not auto-start by default, and does when asked', async () => {
    const { OkBlobRunnerPage } = await import('./OkBlobRunnerPage');
    const { getByTestId, unmount } = render(<OkBlobRunnerPage />);
    expect(getByTestId('runner-probe').dataset.autostart).toBe('false');
    unmount();

    const revealed = render(<OkBlobRunnerPage autoStart />);
    expect(revealed.getByTestId('runner-probe').dataset.autostart).toBe('true');
  });
});
