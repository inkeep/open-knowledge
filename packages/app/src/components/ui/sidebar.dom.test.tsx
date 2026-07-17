import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function resetSidebarCookie(value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: DOM helper intentionally seeds the cookie API the sidebar reads.
  document.cookie = `sidebar_width=${value}; path=/`;
}

async function renderSidebarShell(width: number) {
  setViewportWidth(width);
  const { Sidebar, SidebarGroupLabel, SidebarInset, SidebarProvider, SidebarTrigger } =
    await import('./sidebar');

  render(
    <SidebarProvider defaultWidth="20rem">
      <Sidebar collapsible="offcanvas">
        <SidebarGroupLabel>Files</SidebarGroupLabel>
      </Sidebar>
      <SidebarTrigger />
      <SidebarInset data-testid="sidebar-inset">Main</SidebarInset>
    </SidebarProvider>,
  );
}

describe('Sidebar runtime contracts', () => {
  afterEach(() => {
    cleanup();
    resetSidebarCookie('; max-age=0');
    setViewportWidth(1400);
  });

  test('malformed sidebar_width cookie falls back instead of crashing render', async () => {
    resetSidebarCookie('%');
    const { SidebarProvider } = await import('./sidebar');

    expect(() => {
      render(
        <SidebarProvider defaultWidth="20rem">
          <div>Content</div>
        </SidebarProvider>,
      );
    }).not.toThrow();

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement | null;
    expect(wrapper?.style.getPropertyValue('--sidebar-width')).toBe('20rem');
  });

  test('valid rem/px sidebar_width cookies are applied and invalid values fall back', async () => {
    const { SidebarProvider } = await import('./sidebar');

    resetSidebarCookie('17.5rem');
    const { unmount } = render(
      <SidebarProvider defaultWidth="20rem">
        <div>Content</div>
      </SidebarProvider>,
    );
    expect(
      (
        document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement | null
      )?.style.getPropertyValue('--sidebar-width'),
    ).toBe('17.5rem');
    unmount();

    resetSidebarCookie(encodeURIComponent('calc(100vw)'));
    render(
      <SidebarProvider defaultWidth="20rem">
        <div>Content</div>
      </SidebarProvider>,
    );
    expect(
      (
        document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement | null
      )?.style.getPropertyValue('--sidebar-width'),
    ).toBe('20rem');
  });

  test('desktop sidebar trigger controls a labeled sidebar landmark', async () => {
    await renderSidebarShell(1400);

    const trigger = screen.getByRole('button', { name: /Hide Files/ });
    expect(trigger.getAttribute('aria-controls')).toBe('app-file-sidebar');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const nav = document.querySelector('[data-slot="sidebar-container"]');
    expect(nav?.getAttribute('id')).toBe('app-file-sidebar');
    expect(nav?.getAttribute('aria-label')).toBe('File sidebar');
  });

  test('mobile sidebar branch keeps the same labeled sidebar landmark', async () => {
    await renderSidebarShell(500);

    const trigger = screen.getByRole('button', { name: /Show Files/ });
    expect(trigger.getAttribute('aria-controls')).toBe('app-file-sidebar');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    const nav = document.querySelector('[data-slot="sidebar-container"]');
    expect(nav?.getAttribute('id')).toBe('app-file-sidebar');
    expect(nav?.getAttribute('aria-label')).toBe('File sidebar');
  });

  test('sidebar motion classes preserve duration and reduced-motion gates at runtime', async () => {
    await renderSidebarShell(500);

    const mobileContainer = document.querySelector('[data-slot="sidebar-container"]');
    expectVisualClassTokens(mobileContainer?.getAttribute('class'), [
      'transition-[left,right,width]',
      'duration-200',
      'ease-linear',
      'motion-reduce:transition-none',
    ]);

    cleanup();
    await renderSidebarShell(1400);

    const gap = document.querySelector('[data-slot="sidebar-gap"]');
    expectVisualClassTokens(gap?.getAttribute('class'), [
      'transition-[width]',
      'duration-200',
      'ease-linear',
    ]);

    const desktopContainer = document.querySelector('[data-slot="sidebar-container"]');
    expectVisualClassTokens(desktopContainer?.getAttribute('class'), [
      'transition-[left,right,width]',
      'duration-200',
      'ease-linear',
    ]);

    const inset = screen.getByTestId('sidebar-inset');
    expectVisualClassTokens(inset.getAttribute('class'), [
      'relative',
      'flex',
      'w-full',
      'flex-1',
      'flex-col',
    ]);

    const label = screen.getByText('Files');
    expectVisualClassTokens(label.getAttribute('class'), [
      'transition-[margin,opacity]',
      'duration-200',
      'ease-linear',
    ]);
  });
});
