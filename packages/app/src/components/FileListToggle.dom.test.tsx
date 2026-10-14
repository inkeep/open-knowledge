import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

function setElectronHost(enabled: boolean) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

async function renderToggle(initiallyOpen: boolean) {
  const { FileListToggle } = await import('./FileListToggle');
  function Harness() {
    const [open, setOpen] = useState(initiallyOpen);
    return (
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <TooltipProvider delayDuration={0}>
          <FileListToggle />
        </TooltipProvider>
      </SidebarProvider>
    );
  }
  return render(<Harness />);
}

function toggleButton() {
  return document.querySelector('[data-sidebar="trigger"]') as HTMLElement;
}

describe('FileListToggle', () => {
  afterEach(() => {
    cleanup();
    setElectronHost(false);
  });

  test('its tooltip says what the next press does and shows the shortcut as a keycap', async () => {
    const user = userEvent.setup();
    await renderToggle(true);

    await user.hover(toggleButton());
    const hide = await screen.findByRole('tooltip', {
      name: `Hide Files ${formatShortcutLabel('toggle-files-sidebar')}`,
    });
    expect(hide.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-files-sidebar'),
    );

    cleanup();
    await renderToggle(false);
    await user.hover(toggleButton());
    const show = await screen.findByRole('tooltip', {
      name: `Show Files ${formatShortcutLabel('toggle-files-sidebar')}`,
    });
    expect(show.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-files-sidebar'),
    );
  });

  test('its tooltip opens below the toggle, clear of the window buttons above it', async () => {
    const user = userEvent.setup();
    await renderToggle(true);

    await user.hover(toggleButton());
    await screen.findByRole('tooltip');
    const content = document.querySelector('[data-slot="tooltip-content"]');

    expect(content?.getAttribute('data-side')).toBe('bottom');
  });

  test('pressing it closes the file list and pressing it again reopens it', async () => {
    const user = userEvent.setup();
    await renderToggle(true);

    expect(toggleButton().getAttribute('aria-expanded')).toBe('true');
    await user.click(toggleButton());
    expect(toggleButton().getAttribute('aria-expanded')).toBe('false');
    await user.click(toggleButton());
    expect(toggleButton().getAttribute('aria-expanded')).toBe('true');
  });

  test('on Electron the space around the toggle drags the window while the toggle itself opts out', async () => {
    setElectronHost(true);
    const { container } = await renderToggle(true);
    const zone = container.querySelector('[data-file-list-toggle]') as HTMLElement;

    expect(zone.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(zone.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokens(toggleButton().className, ['[-webkit-app-region:no-drag]']);
  });

  test('on the web the toggle carries no window-drag treatment', async () => {
    const { container } = await renderToggle(true);
    const zone = container.querySelector('[data-file-list-toggle]') as HTMLElement;

    expect(zone.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokensAbsent(zone.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(toggleButton().className, ['[-webkit-app-region:no-drag]']);
  });

  test('a divider separates the toggle from whatever follows it', async () => {
    const { container } = await renderToggle(true);

    const separator = container.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(
      toggleButton().compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
