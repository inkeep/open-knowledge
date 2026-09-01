import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { terminalCommandFor } from '@/components/handoff/terminal-command-events';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { OkSlidesStatusResult } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

function installBridge(
  status: () => Promise<OkSlidesStatusResult>,
  opts: { ptyAvailable?: boolean } = {},
) {
  const statusSpy = vi.fn(status);
  const ptyAvailable = opts.ptyAvailable ?? true;
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    config: { projectPath: '/proj', ptyAvailable },
    platform: 'darwin',
    ...(ptyAvailable ? { terminal: { create: vi.fn() } } : {}),
    slides: { status: statusSpy, open: vi.fn() },
  };
  return statusSpy;
}

async function renderPanel() {
  const { SlidesPluginSection } = await import('./SlidesPluginSection');
  return render(
    <TooltipProvider>
      <SlidesPluginSection />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  vi.clearAllMocks();
});

describe('SlidesPluginSection — availability status', () => {
  test('reports a global install without offering the install command', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: true, source: 'global' }));
    await renderPanel();
    expect(await screen.findByTestId('slides-status-available')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
  });

  test('distinguishes a project-local install, since that is the one that wins', async () => {
    installBridge(() =>
      Promise.resolve({ kind: 'status', available: true, source: 'project-local' }),
    );
    await renderPanel();
    const row = await screen.findByTestId('slides-status-available');
    expect(row.textContent).toContain('this project');
  });

  test('offers the install command — including the theme — when Slidev is absent', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: false }));
    await renderPanel();
    await screen.findByTestId('slides-status-missing');
    const command = (await screen.findByTestId('slides-install-command')) as HTMLInputElement;
    expect(command.value).toContain('@slidev/cli');
    expect(command.value).toContain('@slidev/theme-default');
    const docsLink = screen.getByTestId('slides-install-docs-link') as HTMLAnchorElement;
    expect(docsLink.getAttribute('href')).toBe('https://sli.dev/guide/install');
    expect(docsLink.getAttribute('aria-label')).toBe('Other ways to install Slidev');
  });

  test('says the feature is desktop-only rather than "not installed" off desktop', async () => {
    await renderPanel();
    expect(await screen.findByTestId('slides-status-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
  });

  test('a rejected probe shows a neutral check-failed state, not install guidance', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statusSpy = installBridge(() => Promise.reject(new Error('bridge broke')));
    await renderPanel();
    await waitFor(() => expect(statusSpy).toHaveBeenCalled());
    expect(await screen.findByTestId('slides-status-check-failed')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
    expect(screen.queryByTestId('slides-install-command')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[slides] settings availability probe failed:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  test('sits in the checking state until the probe settles', async () => {
    installBridge(() => new Promise<OkSlidesStatusResult>(() => {}));
    await renderPanel();
    expect(await screen.findByTestId('slides-status-checking')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
    expect(screen.queryByTestId('slides-status-available')).toBeNull();
  });
});

describe('SlidesPluginSection — re-probe', () => {
  test('re-checks on window focus, so installing in a terminal updates the panel', async () => {
    let available = false;
    const statusSpy = installBridge(() =>
      Promise.resolve(
        available
          ? ({ kind: 'status', available: true, source: 'global' } as OkSlidesStatusResult)
          : ({ kind: 'status', available: false } as OkSlidesStatusResult),
      ),
    );
    await renderPanel();
    expect(await screen.findByTestId('slides-status-missing')).toBeTruthy();

    available = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByTestId('slides-status-available')).toBeTruthy();
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  test('stops probing once unmounted', async () => {
    const statusSpy = installBridge(() =>
      Promise.resolve({ kind: 'status', available: false } as OkSlidesStatusResult),
    );
    const { unmount } = await renderPanel();
    await waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1));

    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SlidesPluginSection — run in terminal', () => {
  test('asks the terminal to run the install, and closes Settings first', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const onCommand = (e: Event) => requests.push((e as CustomEvent<string>).detail);
    window.addEventListener('open-knowledge:terminal-command', onCommand);
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    window.location.hash = '#settings/plugin:slides';

    installBridge(() => Promise.resolve({ kind: 'status', available: false }));
    await renderPanel();
    await user.click(await screen.findByTestId('slides-run-install'));

    expect(requests).toEqual(['install-slidev']);
    expect(backSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('open-knowledge:terminal-command', onCommand);
    backSpy.mockRestore();
    window.location.hash = '';
  });

  test('does not offer the run button once Slidev is found', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: true, source: 'global' }));
    await renderPanel();
    await screen.findByTestId('slides-status-available');
    expect(screen.queryByTestId('slides-run-install')).toBeNull();
  });
});

describe('SlidesPluginSection — single source for the command', () => {
  test('shows exactly the command the Run button will execute', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: false }));
    await renderPanel();
    const shown = (await screen.findByTestId('slides-install-command')) as HTMLInputElement;
    expect(shown.value).toBe(terminalCommandFor('install-slidev'));
  });
});

describe('SlidesPluginSection — terminal availability', () => {
  test('hides Run in terminal where no PTY can be spawned', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: false }), {
      ptyAvailable: false,
    });
    await renderPanel();
    await screen.findByTestId('slides-status-missing');
    expect(screen.queryByTestId('slides-run-install')).toBeNull();
    expect(screen.getByTestId('slides-install-command')).toBeTruthy();
    expect(screen.getByTestId('slides-install-docs-link')).toBeTruthy();
  });

  test('offers Run in terminal where a PTY can be spawned', async () => {
    installBridge(() => Promise.resolve({ kind: 'status', available: false }), {
      ptyAvailable: true,
    });
    await renderPanel();
    expect(await screen.findByTestId('slides-run-install')).toBeTruthy();
  });
});
