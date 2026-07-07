/**
 * RTL behavioral test for the web-mode ⌥⌘S sidebar-toggle listener and
 * its Electron host gate (`SidebarProvider`, ui/sidebar.tsx).
 *
 * The renderer keydown listener is the web replacement for shadcn's removed
 * ⌘\ shortcut. Under Electron the native View → Show/Hide Sidebar menu item
 * owns ⌥⌘S and the OS captures the keypress before the renderer, so the
 * provider gates the listener off when `window.okDesktop` is present —
 * otherwise the keypress could double-fire (native toggle + renderer toggle =
 * visible no-op). These tests pin both edges of that gate through the public
 * interface (`useSidebar().state` flips on toggle), so a refactor that drops
 * the gate fails here instead of shipping a double-toggle.
 *
 * Substrate: jsdom via `bun run test:dom`. `window.innerWidth` is pinned to a
 * desktop width so `toggleSidebar` takes the `setOpen` branch and the derived
 * state is `expanded` → `collapsed` on a single toggle.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SidebarProvider, useSidebar } from './sidebar';

function StateProbe() {
  const { state } = useSidebar();
  return <span data-testid="sidebar-state">{state}</span>;
}

function pressSidebarShortcut() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, metaKey: true, code: 'KeyS' }),
    );
  });
}

function setOkDesktop(value: unknown) {
  (window as { okDesktop?: unknown }).okDesktop = value;
}

describe('SidebarProvider web-mode ⌥⌘S shortcut — Electron gate', () => {
  beforeEach(() => {
    window.innerWidth = 1400;
    setOkDesktop(undefined);
  });

  afterEach(() => {
    cleanup();
    setOkDesktop(undefined);
  });

  test('web host (no window.okDesktop): ⌥⌘S toggles the sidebar', () => {
    render(
      <SidebarProvider>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    pressSidebarShortcut();

    expect(screen.getByTestId('sidebar-state').textContent).toBe('collapsed');
  });

  test('Electron host (window.okDesktop set): ⌥⌘S does NOT toggle (native menu owns it)', () => {
    // Gate must be active before the provider's effect subscribes, so set the
    // host marker before render.
    setOkDesktop({});
    render(
      <SidebarProvider>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    pressSidebarShortcut();

    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');
  });

  test('web host (Win/Linux modifier): Ctrl+Alt+S also toggles the sidebar', () => {
    // The Electron accelerator is `CmdOrCtrl+Alt+S` — cross-platform by intent.
    // The renderer listener mirrors that with `(metaKey || ctrlKey)` so Windows
    // and Linux browsers fire on Ctrl+Alt+S where macOS browsers fire on ⌥⌘S.
    render(
      <SidebarProvider>
        <StateProbe />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('sidebar-state').textContent).toBe('expanded');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { altKey: true, ctrlKey: true, code: 'KeyS' }),
      );
    });

    expect(screen.getByTestId('sidebar-state').textContent).toBe('collapsed');
  });
});
