import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/core/macro', () => ({
  msg: renderLinguiTemplate,
}));

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@/lib/external-link', () => ({
  dispatchExternalLinkClick: () => {},
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

const originalFetch = globalThis.fetch;

describe('HelpPopover runtime behavior', () => {
  beforeEach(() => {
    // Stub the GitHub star-count fetch so the count is deterministic and no
    // real network call fires during the test.
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ stargazers_count: 1234 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof globalThis.fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

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
        label: 'File an issue',
        href: 'https://github.com/inkeep/open-knowledge/issues/new',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
      {
        label: 'Website',
        href: 'https://openknowledge.ai/',
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
        label: 'Discord',
        href: 'https://discord.com/invite/YujKpFN49',
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
        label: 'GitHub',
        href: 'https://github.com/inkeep/open-knowledge',
        target: '_blank',
        rel: 'noopener noreferrer',
        hasIcon: true,
      },
    ]);
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
