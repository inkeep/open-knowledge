/**
 * Settings -> Hotkeys is host-aware: a chord that only a native menu
 * accelerator can deliver is not advertised to a browser that has no menu bar.
 *
 * The load-bearing assertion is the one that pins what STAYS on web. Several
 * rows carry an `OK Desktop` scope and are listed on web anyway, so every
 * derivable host filter would have deleted them; `web list === desktop list
 * minus the declared rows` is what makes that a red test instead of a quiet
 * regression.
 *
 * Deliberately does NOT mock `@lingui/react/macro`, unlike most sibling suites
 * here — the config-wide macro shim renders every message in English, so these
 * assertions read the same copy a user sees.
 *
 * Substrate: jsdom via `pnpm run test:dom`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { formatShortcut, KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts';
import { HotkeysSection } from './HotkeysSection';

function setDesktopHost(present: boolean): void {
  (globalThis as unknown as { window: { okDesktop?: unknown } }).window.okDesktop = present
    ? {}
    : undefined;
}

/** Shortcut ids in the order the list renders them. */
function renderedShortcutIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="settings-hotkey-"]')).map((row) =>
    (row.getAttribute('data-testid') ?? '').replace('settings-hotkey-', ''),
  );
}

/** Category headings in the order the list renders them. */
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
    // The chord the rest of the app formats for this id, not a literal: the
    // glyphs themselves are pinned in `keyboard-shortcuts.test.ts`, and jsdom
    // reports a non-mac platform so a literal here would encode that.
    expect(row.querySelector('[data-slot="kbd"]')?.textContent).toBe(formatShortcut('report-bug'));
  });

  test('omits the Report a bug shortcut on the web host', () => {
    renderUnderHost(false);

    expect(screen.queryByTestId('settings-hotkey-report-bug')).toBeNull();
  });

  test('keeps every other row on web, including the OK Desktop-scoped ones', () => {
    // All three carry an `OK Desktop` scope; two (`new-folder`, `navigate-back`)
    // declare no renderer `match` and also set `shortcutDesktopOnly` on their
    // command identity, while `toggle-terminal-panel` declares two matches. A
    // filter derived from any of those incidental signals rather than from the
    // shortcut's own declared flag would drop at least one of them here, which
    // is the regression this pins.
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
