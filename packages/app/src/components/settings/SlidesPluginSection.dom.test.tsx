/**
 * DOM tests for the Slides settings panel. This panel is the only surface that
 * makes an unresolved Slidev visible — everywhere else its absence is silent by
 * design — so these cover each status it can report plus the re-probe that lets
 * the panel correct itself after the user installs Slidev in a terminal.
 */

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
    // The terminal surface is absent on hosts that cannot spawn a PTY.
    ...(ptyAvailable ? { terminal: { create: vi.fn() } } : {}),
    slides: { status: statusSpy, open: vi.fn() },
  };
  return statusSpy;
}

async function renderPanel() {
  const { SlidesPluginSection } = await import('./SlidesPluginSection');
  // Production mounts this deep inside main.tsx's app-root TooltipProvider
  // (which five other settings panels already rely on); supply one here only
  // because the panel is rendered in isolation.
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
    // Read the control the user actually copies from, not the container's text —
    // the command lives in a readonly input, which contributes no textContent.
    const command = (await screen.findByTestId('slides-install-command')) as HTMLInputElement;
    // The theme is a separate package and a deck cannot boot without it, so a
    // command naming only the CLI would send the user back to a broken deck.
    expect(command.value).toContain('@slidev/cli');
    expect(command.value).toContain('@slidev/theme-default');
    // The "other ways to install" link points at Slidev's own install guide and
    // names its destination for assistive tech listing links out of context.
    const docsLink = screen.getByTestId('slides-install-docs-link') as HTMLAnchorElement;
    expect(docsLink.getAttribute('href')).toBe('https://sli.dev/guide/install');
    expect(docsLink.getAttribute('aria-label')).toBe('Other ways to install Slidev');
  });

  test('says the feature is desktop-only rather than "not installed" off desktop', async () => {
    // No okDesktop bridge at all — the web build. Reporting "not installed"
    // here would send the user to install something that still would not help.
    await renderPanel();
    expect(await screen.findByTestId('slides-status-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
  });

  test('a rejected probe shows a neutral check-failed state, not install guidance', async () => {
    // A broken bridge is not an absent Slidev — the binary may be present, so
    // offering the install command would send the user after software they
    // already have. The fault is reported as check-failed and logged.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statusSpy = installBridge(() => Promise.reject(new Error('bridge broke')));
    await renderPanel();
    await waitFor(() => expect(statusSpy).toHaveBeenCalled());
    expect(await screen.findByTestId('slides-status-check-failed')).toBeTruthy();
    // The amber "not installed" remediation must NOT appear for a transport fault.
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
    expect(screen.queryByTestId('slides-install-command')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[slides] settings availability probe failed:',
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  test('sits in the checking state until the probe settles', async () => {
    // A probe that never resolves — the panel holds "Checking", never flashing a
    // found / missing verdict it does not have yet.
    installBridge(() => new Promise<OkSlidesStatusResult>(() => {}));
    await renderPanel();
    expect(await screen.findByTestId('slides-status-checking')).toBeTruthy();
    expect(screen.queryByTestId('slides-status-missing')).toBeNull();
    expect(screen.queryByTestId('slides-status-available')).toBeNull();
  });
});

describe('SlidesPluginSection — re-probe', () => {
  test('re-checks on window focus, so installing in a terminal updates the panel', async () => {
    // The whole point of the panel: the user reads "not installed", installs in
    // a terminal, and switches back. That switch is the focus event.
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

    // A leaked focus listener would keep probing (and setState) after unmount.
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
    // The dialog is hash-routed; only an open dialog should be dismissed.
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
    // The panel used to restate the command as its own constant. Displaying one
    // command while running another is invisible drift: the user copies the
    // text, runs it, and gets a different result than the button would have.
    installBridge(() => Promise.resolve({ kind: 'status', available: false }));
    await renderPanel();
    const shown = (await screen.findByTestId('slides-install-command')) as HTMLInputElement;
    expect(shown.value).toBe(terminalCommandFor('install-slidev'));
  });
});

describe('SlidesPluginSection — terminal availability', () => {
  test('hides Run in terminal where no PTY can be spawned (Windows / Linux)', async () => {
    // node-pty is macOS-only, so the dock is dark off-mac and `ptyAvailable` is
    // false. Rendering the button there would close Settings, fire the request,
    // and produce no session — the click would look swallowed.
    installBridge(() => Promise.resolve({ kind: 'status', available: false }), {
      ptyAvailable: false,
    });
    await renderPanel();
    await screen.findByTestId('slides-status-missing');
    expect(screen.queryByTestId('slides-run-install')).toBeNull();
    // The copy path is platform-independent and must survive.
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
