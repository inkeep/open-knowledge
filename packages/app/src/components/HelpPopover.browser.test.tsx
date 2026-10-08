import { FALLBACK_LOCALE } from '@inkeep/open-knowledge-core/i18n/resolve-locale';
import type { Messages } from '@lingui/core';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { i18n } from '@/lib/i18n';
import spanishCatalog from '@/locales/es/messages.json';
import { renderWithI18n } from '../../tests/foundation/render-with-i18n.test-helper';
import { HelpPopover } from './HelpPopover';

vi.mock('@inkeep/open-knowledge-core/utils/github-stars', () => ({
  getGitHubStars: async () => 1234,
}));

const CLOUD_VERSION = '0.84.1-cloud.1596';

function installDesktopBridge(appVersion: string) {
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    appVersion,
    update: { checkNow: async () => {} },
    state: {
      query: async () => ({ channel: 'latest' as const, schemaIncompatibility: null }),
    },
  };
}

async function openHelpPopover(triggerName = 'Resources'): Promise<HTMLElement> {
  renderWithI18n(
    <TooltipProvider>
      <HelpPopover />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: triggerName }));
  return screen.findByTestId('help-popover-version');
}

function popoverContent(row: HTMLElement): HTMLElement {
  const content = row.closest<HTMLElement>('[data-slot="popover-content"]');
  if (content === null) throw new Error('the version row is not inside the popover content');
  return content;
}

function clipping(element: HTMLElement, container: HTMLElement) {
  const box = element.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  return {
    text: element.textContent,
    clippedInline: element.scrollWidth > element.clientWidth,
    outsideContainer: box.left < bounds.left || box.right > bounds.right,
  };
}

afterEach(() => {
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  act(() => i18n.activate(FALLBACK_LOCALE));
});

describe('HelpPopover version footer layout', () => {
  test('a Cloud build version leaves the whole footer inside the popover with no horizontal scroll', async () => {
    installDesktopBridge(CLOUD_VERSION);
    const row = await openHelpPopover();
    const content = popoverContent(row);
    const [version, label] = Array.from(row.children) as HTMLElement[];

    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
    expect(clipping(version, content)).toEqual({
      text: `v${CLOUD_VERSION}`,
      clippedInline: false,
      outsideContainer: false,
    });
    expect(clipping(label, content)).toEqual({
      text: 'About & updates',
      clippedInline: false,
      outsideContainer: false,
    });
  });

  test('a longer translated label stays inside the popover with a Cloud build version', async () => {
    i18n.load('es', spanishCatalog.messages as unknown as Messages);
    act(() => i18n.activate('es'));
    installDesktopBridge(CLOUD_VERSION);
    const row = await openHelpPopover('Recursos');
    const content = popoverContent(row);
    const label = row.children[1] as HTMLElement;

    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth);
    expect(clipping(label, content)).toEqual({
      text: 'Información y actualizaciones',
      clippedInline: false,
      outsideContainer: false,
    });
  });
});
