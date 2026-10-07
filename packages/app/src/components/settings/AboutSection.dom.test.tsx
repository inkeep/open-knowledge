import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkAboutInfo, OkUpdateManualCheckInfo } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { AboutSection } = await import('./AboutSection');

const CLOUD_ABOUT: OkAboutInfo = {
  productName: 'OpenKnowledge Cloud',
  version: '0.81.5-cloud.1343',
  releasesUrl: 'https://github.com/inkeep/agents-private/releases',
  releaseNotesUrl: 'https://github.com/inkeep/agents-private/releases/tag/v0.81.5-cloud.1343',
  updateChecks: 'available',
};

function installBridge(about: OkAboutInfo | null, appVersion = about?.version ?? '0.0.0') {
  const openExternal = vi.fn(async (_url: string) => {});
  const checkNow = vi.fn(async () => {});
  const query = vi.fn(async () => ({
    channel: 'latest' as const,
    schemaIncompatibility: null,
    ...(about ? { about } : {}),
  }));
  let emitManualCheck: (info: OkUpdateManualCheckInfo) => void = () => {};
  Object.defineProperty(window, 'okDesktop', {
    value: {
      appVersion,
      shell: { openExternal },
      update: { checkNow },
      state: { query },
      onUpdateManualCheck: (cb: (info: OkUpdateManualCheckInfo) => void) => {
        emitManualCheck = cb;
        return () => {};
      },
    },
    configurable: true,
    writable: true,
  });
  return {
    openExternal,
    checkNow,
    query,
    emit: (info: OkUpdateManualCheckInfo) => emitManualCheck(info),
  };
}

afterEach(() => {
  cleanup();
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
});

describe('AboutSection', () => {
  test('shows the installed product and its version', async () => {
    installBridge(CLOUD_ABOUT);
    render(<AboutSection />);

    expect(await screen.findByText('OpenKnowledge Cloud')).not.toBeNull();
    expect(screen.getByTestId('settings-about-version').textContent).toBe('v0.81.5-cloud.1343');
  });

  test('Release notes opens the page the installed build names', async () => {
    const { openExternal } = installBridge(CLOUD_ABOUT);
    render(<AboutSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Release notes' }));

    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/inkeep/agents-private/releases/tag/v0.81.5-cloud.1343',
    );
  });

  test('Check for updates starts a check and waits for it to settle', async () => {
    const { checkNow, emit } = installBridge(CLOUD_ABOUT);
    render(<AboutSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
    expect(checkNow).toHaveBeenCalledTimes(1);

    act(() => emit({ phase: 'started' }));
    const busy = screen.getByRole('button', { name: /Checking for updates/ });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(busy);
    expect(checkNow).toHaveBeenCalledTimes(1);

    act(() => emit({ phase: 'settled' }));
    const idle = await screen.findByRole('button', { name: 'Check for updates' });
    expect(idle.hasAttribute('aria-disabled')).toBe(false);
    expect(idle.hasAttribute('disabled')).toBe(false);
  });

  test('the busy button keeps keyboard focus while a check runs', async () => {
    const { emit } = installBridge(CLOUD_ABOUT);
    render(<AboutSection />);

    const button = await screen.findByRole('button', { name: 'Check for updates' });
    button.focus();
    act(() => emit({ phase: 'started' }));

    const busy = screen.getByRole('button', { name: /Checking for updates/ });
    expect(busy.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(busy);
  });

  test('a build without a running updater explains why it cannot check', async () => {
    const { checkNow } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
    render(<AboutSection />);

    const button = await screen.findByRole('button', { name: 'Check for updates' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Automatic updates are not available right now.')).not.toBeNull();
    await userEvent.click(button);
    expect(checkNow).not.toHaveBeenCalled();
  });

  test('returning to the window picks up an updater that finished booting', async () => {
    const { query } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
    render(<AboutSection />);
    await screen.findByText('Automatic updates are not available right now.');

    query.mockResolvedValue({ channel: 'latest', schemaIncompatibility: null, about: CLOUD_ABOUT });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(screen.queryByText('Automatic updates are not available right now.')).toBeNull();
  });

  test('the window becoming visible again rereads the updater state', async () => {
    const { query } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
    render(<AboutSection />);
    await screen.findByText('Automatic updates are not available right now.');

    query.mockResolvedValue({ channel: 'latest', schemaIncompatibility: null, about: CLOUD_ABOUT });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() =>
      expect(screen.queryByText('Automatic updates are not available right now.')).toBeNull(),
    );
  });

  test('a check started elsewhere refreshes a stale unavailable state', async () => {
    const { query, emit } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
    render(<AboutSection />);
    await screen.findByText('Automatic updates are not available right now.');

    query.mockResolvedValue({ channel: 'latest', schemaIncompatibility: null, about: CLOUD_ABOUT });
    act(() => emit({ phase: 'settled' }));

    await waitFor(() =>
      expect(screen.queryByText('Automatic updates are not available right now.')).toBeNull(),
    );
  });

  test('a page left open in a focused window picks up an updater that finishes booting', async () => {
    vi.useFakeTimers();
    try {
      const { query } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Automatic updates are not available right now.')).not.toBeNull();

      query.mockResolvedValue({
        channel: 'latest',
        schemaIncompatibility: null,
        about: CLOUD_ABOUT,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.queryByText('Automatic updates are not available right now.')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a build whose updater never starts stops rereading after a bounded wait', async () => {
    vi.useFakeTimers();
    try {
      const { query } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      const readsAfterWait = query.mock.calls.length;
      expect(readsAfterWait).toBeGreaterThan(1);
      expect(readsAfterWait).toBeLessThanOrEqual(25);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(query.mock.calls.length).toBe(readsAfterWait);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed reread does not stop the wait for the updater', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { query } = installBridge({ ...CLOUD_ABOUT, updateChecks: 'unavailable' });
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Automatic updates are not available right now.')).not.toBeNull();

      query.mockRejectedValueOnce(new Error('state query gone'));
      query.mockResolvedValue({
        channel: 'latest',
        schemaIncompatibility: null,
        about: CLOUD_ABOUT,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(warn).toHaveBeenCalledWith(
        '[about-section] bridge.state.query() failed',
        expect.any(Error),
      );
      expect(screen.queryByText('Automatic updates are not available right now.')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled'),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test('a failed first read still reaches an updater that finishes booting', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { query } = installBridge(CLOUD_ABOUT);
      query.mockRejectedValueOnce(new Error('state query gone'));
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(
        screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled'),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test('a state query that keeps failing stops rereading after a bounded wait', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { query } = installBridge(CLOUD_ABOUT);
      query.mockRejectedValue(new Error('state query gone'));
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      const readsAfterWait = query.mock.calls.length;
      expect(readsAfterWait).toBeGreaterThan(1);
      expect(readsAfterWait).toBeLessThanOrEqual(25);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(query.mock.calls.length).toBe(readsAfterWait);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test('an available updater is not polled', async () => {
    vi.useFakeTimers();
    try {
      const { query } = installBridge(CLOUD_ABOUT);
      render(<AboutSection />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed About read or check leaves a renderer log entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { query, checkNow } = installBridge(CLOUD_ABOUT);
      const queryError = new Error('state query gone');
      query.mockRejectedValueOnce(queryError);
      render(<AboutSection />);
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[about-section] bridge.state.query() failed',
          queryError,
        ),
      );

      const checkError = new Error('check-now handler removed');
      checkNow.mockRejectedValueOnce(checkError);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[about-section] bridge.update.checkNow() failed',
          checkError,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('an older desktop build without About data still shows its version', async () => {
    const { openExternal, checkNow } = installBridge(null, '0.80.0');
    render(<AboutSection />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-about-version').textContent).toBe('v0.80.0'),
    );
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    expect(checkNow).not.toHaveBeenCalled();
  });
});
