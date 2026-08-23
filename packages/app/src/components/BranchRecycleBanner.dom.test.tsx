import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BRANCH_SWITCH_NOTICE_MS, type ContentRecycleNotice } from '@/lib/branch-recycle-notice';

let notice: ContentRecycleNotice | null = null;
const dismiss = vi.fn();
const restartMock = vi.fn();

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    contentRecycleNotice: notice,
    dismissContentRecycleNotice: dismiss,
  }),
}));
vi.mock('@/lib/restart-collab-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restart-collab-server')>(
    '@/lib/restart-collab-server',
  );
  return { ...actual, restartCollabServer: restartMock };
});

async function renderBanner() {
  const { BranchRecycleBanner } = await import('./BranchRecycleBanner');
  return render(<BranchRecycleBanner />);
}

afterEach(() => {
  cleanup();
  notice = null;
  dismiss.mockReset();
  restartMock.mockReset();
});

test('renders nothing without a notice', async () => {
  await renderBanner();
  expect(screen.queryByTestId('branch-recycle-banner-switch')).toBeNull();
  expect(screen.queryByTestId('branch-recycle-banner-refused')).toBeNull();
});

test('a fresh branch switch shows the transient status naming the branch', async () => {
  notice = { kind: 'branch-switch', branch: 'feat/x', at: Date.now() };
  await renderBanner();
  const banner = screen.getByTestId('branch-recycle-banner-switch');
  expect(banner.textContent).toContain('feat/x');
  expect(banner.getAttribute('role')).toBe('status');
});

test('a refused notice is an alert with a Reload action and a working Dismiss', async () => {
  notice = { kind: 'refused', at: Date.now() };
  await renderBanner();
  const banner = screen.getByTestId('branch-recycle-banner-refused');
  expect(banner.getAttribute('role')).toBe('alert');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

test('the transient switch banner dismisses itself after its deadline', async () => {
  vi.useFakeTimers();
  try {
    notice = { kind: 'branch-switch', branch: 'feat/x', at: Date.now() };
    await renderBanner();
    expect(screen.getByTestId('branch-recycle-banner-switch')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(BRANCH_SWITCH_NOTICE_MS + 50);
    });

    expect(screen.queryByTestId('branch-recycle-banner-switch')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test('with the desktop bridge, Restart server disables in flight and re-enables on failure', async () => {
  // A resolvable-later promise: the button must read as busy while the restart
  // is in flight, and only a resolved FAILURE hands the button back (success
  // tears the window down).
  let resolveRestart: (v: { ok: boolean }) => void = () => {};
  restartMock.mockImplementation(
    () =>
      new Promise<{ ok: boolean }>((resolve) => {
        resolveRestart = resolve;
      }),
  );
  Object.defineProperty(window, 'okDesktop', {
    value: { restart: true },
    configurable: true,
    writable: true,
  });
  try {
    notice = { kind: 'refused', at: Date.now() };
    await renderBanner();

    const button = screen.getByRole('button', { name: 'Restart server' });
    fireEvent.click(button);
    expect(restartMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Restarting' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => {
      resolveRestart({ ok: false });
    });
    expect(
      (screen.getByRole('button', { name: 'Restart server' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  } finally {
    Reflect.deleteProperty(window, 'okDesktop');
  }
});
