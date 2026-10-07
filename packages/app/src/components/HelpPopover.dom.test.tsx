import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import { createServedBindingLog } from '@/test-utils/served-binding.test-helper';

vi.doMock('@lingui/core/macro', () => ({ ...actualLinguiMacro, msg: renderLinguiTemplate }));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const servedCore = createServedBindingLog();

vi.doMock('@inkeep/open-knowledge-core/utils/github-stars', async (importActual) =>
  servedCore.serve('@inkeep/open-knowledge-core/utils/github-stars', {
    ...(await importActual<typeof import('@inkeep/open-knowledge-core/utils/github-stars')>()),
    getGitHubStars: async () => 1234,
  }),
);

vi.doMock('@/lib/external-link', () => ({
  dispatchExternalLinkClick: () => {},
}));

const reportBugDialogProps: Array<{ open: boolean; launcherBorne?: boolean }> = [];
vi.doMock('@/components/ReportBugDialog', () => ({
  ReportBugDialog: (props: { open: boolean; launcherBorne?: boolean }) => {
    reportBugDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="report-bug-dialog" />;
  },
}));

async function renderOpenHelpPopover() {
  const { HelpPopover } = await import('./HelpPopover');
  render(
    <TooltipProvider>
      <HelpPopover />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Resources' }));
}

function linkShape(link: HTMLElement) {
  return {
    label: Array.from(link.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('')
      .trim(),
    href: link.getAttribute('href'),
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel'),
    hasIcon: link.querySelector('svg') !== null,
  };
}

afterEach(cleanup);

describe('HelpPopover runtime behavior', () => {
  test('exports the component', async () => {
    const mod = await import('./HelpPopover');
    expect(typeof mod.HelpPopover).toBe('function');
  });

  test('groups links under Resources, Community, and Product updates navs', async () => {
    await renderOpenHelpPopover();

    for (const heading of ['Resources', 'Community', 'Product updates']) {
      expect(screen.getByRole('navigation', { name: heading })).not.toBeNull();
    }
    expect(screen.queryByText(/Help\s*&\s*Resources/i)).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
  });

  test('omits the desktop-only Report a bug action in the web host', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Resources' });
    expect(within(nav).queryByRole('button', { name: 'Report a bug' })).toBeNull();
  });

  test('renders Resources links in the required order', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Resources' });
    const links = within(nav).getAllByRole('link');
    expect(links.map(linkShape)).toEqual([
      {
        label: 'Docs',
        href: 'https://openknowledge.ai/docs',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
      {
        label: 'Download app',
        href: 'https://openknowledge.ai/download',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
    ]);
  });

  test('renders Community links in the required order', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Community' });
    const links = within(nav).getAllByRole('link');
    expect(links.map(linkShape)).toEqual([
      {
        label: 'GitHub',
        href: 'https://github.com/inkeep/open-knowledge',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
      {
        label: 'X (Twitter)',
        href: 'https://x.com/OpenKnowledge',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
      {
        label: 'Discord',
        href: 'https://discord.gg/VRKk2EaGHN',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
    ]);
  });

  test('does not advertise the hidden game', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Resources' });
    expect(within(nav).queryByRole('button', { name: 'Blob Run' })).toBeNull();
  });

  test('shows the fetched GitHub star count on the GitHub row', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Community' });
    const githubLink = within(nav).getByRole('link', { name: /GitHub/ });
    await waitFor(() => expect(within(githubLink).getByText('1.2k')).not.toBeNull());
  });

  test('Product updates exposes a What’s new link and a Subscribe action', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Product updates' });
    const whatsNew = within(nav).getByRole('link', { name: "What's new" });
    expect(whatsNew.getAttribute('href')).toBe('https://github.com/inkeep/open-knowledge/releases');

    const subscribe = within(nav).getByRole('button', { name: 'Subscribe' });
    expect(subscribe).not.toBeNull();

    await userEvent.click(subscribe);
    expect(screen.getByTestId('subscribe-email')).not.toBeNull();
  });
});

describe('HelpPopover with the desktop bridge present', () => {
  beforeEach(() => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = {
      state: { query: async () => ({ channel: 'latest', schemaIncompatibility: null }) },
    };
  });

  afterEach(() => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('adds Report a bug and Send feedback actions after the Docs link', async () => {
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Resources' });
    const docs = within(nav).getByRole('link', { name: 'Docs' });
    const reportBug = within(nav).getByRole('button', { name: 'Report a bug' });
    const sendFeedback = within(nav).getByRole('button', { name: 'Send feedback' });

    expect(docs.compareDocumentPosition(reportBug)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(docs.compareDocumentPosition(sendFeedback)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('the report it opens waits for the popover to clear before shooting', async () => {
    reportBugDialogProps.length = 0;
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Resources' });
    await userEvent.click(within(nav).getByRole('button', { name: 'Report a bug' }));

    await waitFor(() => {
      expect(screen.getByTestId('report-bug-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(reportBugDialogProps.at(-1)?.launcherBorne).toBe(true);
  });

  test('keeps the download route available for reinstalling or sharing from desktop', async () => {
    await renderOpenHelpPopover();

    expect(screen.getByRole('link', { name: 'Download app' }).getAttribute('href')).toBe(
      'https://openknowledge.ai/download',
    );
  });
});

describe('HelpPopover version and updates on the desktop app', () => {
  function aboutInfo(updateChecks: 'available' | 'unavailable') {
    return {
      productName: 'OpenKnowledge Beta',
      version: '0.83.0-beta.8',
      releasesUrl: 'https://example.test/releases',
      releaseNotesUrl: 'https://example.test/releases/tag/v0.83.0-beta.8',
      updateChecks,
    };
  }

  function installBridge(updateChecks: 'available' | 'unavailable' | null) {
    const checkNow = vi.fn(async () => {});
    const snapshot = (checks: 'available' | 'unavailable' | null) => ({
      channel: 'latest' as const,
      schemaIncompatibility: null,
      ...(checks ? { about: aboutInfo(checks) } : {}),
    });
    const query = vi.fn(async () => snapshot(updateChecks));
    (window as unknown as { okDesktop?: unknown }).okDesktop = {
      appVersion: '0.83.0-beta.8',
      update: { checkNow },
      state: { query },
    };
    return { checkNow, query, snapshot };
  }

  async function waitForAboutData() {
    const nav = screen.getByRole('navigation', { name: 'Product updates' });
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: "What's new" }).getAttribute('href')).toBe(
        'https://example.test/releases',
      ),
    );
  }

  afterEach(() => {
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
    window.location.hash = '';
  });

  test('the version row opens Settings at About & updates', async () => {
    installBridge('available');
    await renderOpenHelpPopover();

    await userEvent.click(screen.getByRole('button', { name: 'v0.83.0-beta.8 About & updates' }));

    expect(window.location.hash).toBe('#settings/about');
  });

  test('Check for updates starts a check when the updater is running', async () => {
    const { checkNow } = installBridge('available');
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Product updates' });
    await userEvent.click(await within(nav).findByRole('button', { name: 'Check for updates' }));

    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  test('What’s new follows the release page the installed build names', async () => {
    installBridge('available');
    await renderOpenHelpPopover();

    await waitForAboutData();
  });

  test('Check for updates is absent when the updater did not start', async () => {
    installBridge('unavailable');
    await renderOpenHelpPopover();

    await waitForAboutData();
    expect(screen.getByRole('button', { name: 'v0.83.0-beta.8 About & updates' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });

  test('reopening the popover picks up an updater that finished booting', async () => {
    const { query, snapshot } = installBridge('unavailable');
    await renderOpenHelpPopover();
    await waitForAboutData();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();

    query.mockResolvedValue(snapshot('available'));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Resources' }));

    const nav = screen.getByRole('navigation', { name: 'Product updates' });
    expect(await within(nav).findByRole('button', { name: 'Check for updates' })).not.toBeNull();
  });

  test('a failed About read or check leaves a renderer log entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { query, checkNow } = installBridge('available');
      const queryError = new Error('state query gone');
      query.mockRejectedValueOnce(queryError);
      await renderOpenHelpPopover();
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith('[help-popover] bridge.state.query() failed', queryError),
      );

      const checkError = new Error('check-now handler removed');
      checkNow.mockRejectedValueOnce(checkError);
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByRole('button', { name: 'Resources' }));
      const nav = screen.getByRole('navigation', { name: 'Product updates' });
      await userEvent.click(await within(nav).findByRole('button', { name: 'Check for updates' }));
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[help-popover] bridge.update.checkNow() failed',
          checkError,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('an older desktop build without About data keeps the version row only', async () => {
    installBridge(null);
    await renderOpenHelpPopover();
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'v0.83.0-beta.8 About & updates' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
    expect(screen.getByRole('link', { name: "What's new" }).getAttribute('href')).toBe(
      'https://github.com/inkeep/open-knowledge/releases',
    );
  });

  test('the web host shows no version row', async () => {
    await renderOpenHelpPopover();

    expect(screen.queryByRole('button', { name: /^v\d/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });
});

describe('HelpPopover core replacement liveness', () => {
  test('the star count HelpPopover renders is the one the github-stars replacement serves', async () => {
    const since = servedCore.mark();
    await renderOpenHelpPopover();

    const nav = screen.getByRole('navigation', { name: 'Community' });
    const githubLink = within(nav).getByRole('link', { name: /GitHub/ });
    await waitFor(() => expect(within(githubLink).getByText('1.2k')).not.toBeNull());
    expect(
      servedCore.readersOf(
        '@inkeep/open-knowledge-core/utils/github-stars',
        'getGitHubStars',
        since,
      ),
    ).toEqual(['components/HelpPopover.tsx']);
  });
});
