import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { formatShortcut, KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import { HotkeysSection } from './HotkeysSection';

function setDesktopHost(present: boolean): void {
  (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = present
    ? {}
    : undefined;
}

function renderedShortcutIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="settings-hotkey-"]')).map((row) =>
    (row.getAttribute('data-testid') ?? '').replace('settings-hotkey-', ''),
  );
}

function renderedCategoryLabels(): string[] {
  return Array.from(document.querySelectorAll('h4[id^="settings-hotkeys-"]')).map(
    (heading) => heading.textContent ?? '',
  );
}

function renderUnderHost(desktop: boolean): void {
  setDesktopHost(desktop);
  render(<HotkeysSection />);
}

afterEach(() => {
  cleanup();
  setDesktopHost(false);
});

describe('HotkeysSection host awareness', () => {
  test('lists the Report a bug chord under General on the desktop host', () => {
    renderUnderHost(true);

    const row = screen.getByTestId('settings-hotkey-report-bug');
    expect(row.closest('section')?.getAttribute('aria-labelledby')).toBe(
      'settings-hotkeys-general',
    );
    expect(row.textContent).toContain('Report a bug');
    expect(row.querySelector('[data-slot="kbd"]')?.textContent).toBe(formatShortcut('report-bug'));
  });

  test('omits the Report a bug shortcut on the web host', () => {
    renderUnderHost(false);

    expect(screen.queryByTestId('settings-hotkey-report-bug')).toBeNull();
  });

  test('keeps every other row on web, including the OK Desktop-scoped ones', () => {
    renderUnderHost(false);

    for (const id of ['new-folder', 'toggle-terminal-panel', 'navigate-back']) {
      expect(screen.queryByTestId(`settings-hotkey-${id}`)).not.toBeNull();
    }
  });

  test('the web list is the desktop list minus exactly the desktop-only rows', () => {
    renderUnderHost(true);
    const desktopIds = renderedShortcutIds();
    cleanup();
    renderUnderHost(false);
    const webIds = renderedShortcutIds();

    const declaredDesktopOnly = new Set(
      KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.desktopOnly === true).map(
        (shortcut) => shortcut.id,
      ),
    );
    expect(declaredDesktopOnly.size).toBeGreaterThan(0);
    expect(webIds).toEqual(desktopIds.filter((id) => !declaredDesktopOnly.has(id)));
  });

  test('renders the same categories in the same order on both hosts', () => {
    renderUnderHost(true);
    const desktopCategories = renderedCategoryLabels();
    cleanup();
    renderUnderHost(false);

    expect(renderedCategoryLabels()).toEqual(desktopCategories);
  });
});
