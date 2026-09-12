import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type WindowGlobals = { MutationObserver?: typeof MutationObserver; NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string | { message: string }, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      if ('message' in strings) return strings.message;
      return strings.reduce(
        (text, chunk, index) =>
          `${text}${chunk}${index < values.length ? String(values[index]) : ''}`,
        '',
      );
    },
  }),
}));

const probeActiveIds: string[] = [];
let showSpellingRow = false;
const { SpellcheckLanguagesRow } = await import('./SpellcheckLanguagesRow');
vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: ({ activeId }: { activeId: string }) => {
    probeActiveIds.push(activeId);
    return (
      <div data-testid="settings-body-probe">
        {showSpellingRow ? <SpellcheckLanguagesRow /> : null}
        <div data-field="spellcheck.enabled" data-testid="probe-spellcheck-block" />
        <div data-field="spellcheck.languages" data-testid="probe-spellcheck-languages-block" />
      </div>
    );
  },
}));

vi.doMock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: 'ws://test.invalid' }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    okignoreBinding: null,
    okignoreSynced: false,
  }),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({ desktopPresent: false }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function setHost(platform: 'darwin' | 'win32' | 'linux' | null) {
  const w = window as unknown as { okDesktop?: unknown };
  w.okDesktop = platform === null ? undefined : { platform, config: { ptyAvailable: false } };
}

const TOGGLE_RESULT_ID = 'settings-search-result-subsection:preferences:spellcheck';
const LANGUAGES_RESULT_ID = 'settings-search-result-subsection:preferences:spellcheck-languages';

async function searchSpellcheck(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('settings-search-input'), 'spellcheck');
}

describe('SettingsDialogShell spelling search entries', () => {
  test.each(['darwin', 'win32', 'linux', null] as const)(
    'Escape from settings search closes Settings on %s',
    async (platform) => {
      setHost(platform);
      function SettingsHarness() {
        const [open, setOpen] = useState(true);
        return <SettingsDialogShell open={open} onOpenChange={setOpen} />;
      }
      render(<SettingsHarness />);
      const search = await screen.findByTestId('settings-search-input');
      await userEvent.click(search);
      expect(document.activeElement).toBe(search);
      await userEvent.keyboard('[Escape]');
      await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
    },
  );

  test.each(['input', 'chip'] as const)(
    'Escape follows the language popup state from %s focus',
    async (focusTarget) => {
      showSpellingRow = true;
      Object.defineProperty(window, 'okDesktop', {
        configurable: true,
        value: {
          platform: 'win32',
          config: { ptyAvailable: false },
          spellcheck: {
            languages: async () => ({
              ok: true,
              state: { available: ['en-US', 'vi'], selected: ['en-US'], defaults: ['en-US'] },
            }),
            setLanguages: async (selected: string[]) => ({
              ok: true,
              state: { available: ['en-US', 'vi'], selected, defaults: ['en-US'] },
            }),
          },
        },
      });
      function SettingsHarness() {
        const [open, setOpen] = useState(true);
        return <SettingsDialogShell open={open} onOpenChange={setOpen} />;
      }
      render(
        <TooltipProvider>
          <SettingsHarness />
        </TooltipProvider>,
      );
      const trigger = await screen.findByTestId('settings-spellcheck-languages-trigger');
      await userEvent.click(trigger);
      const input = await screen.findByRole('combobox', { name: 'Spelling languages' });
      await userEvent.type(input, 'Vietnamese');
      await userEvent.keyboard('[ArrowDown][Enter]');
      await waitFor(() => expect(trigger.textContent).toContain('Vietnamese'));
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      await userEvent.click(input);
      await screen.findByRole('listbox');
      if (focusTarget === 'chip') {
        await userEvent.keyboard('[Home][ArrowLeft]');
        expect(document.activeElement?.getAttribute('data-slot')).toBe('combobox-chip');
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
        expect(input.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByTestId('settings-dialog')).toBeDefined();
        await userEvent.keyboard('[Escape]');
        await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
        return;
      }
      await userEvent.keyboard('[Escape]');
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      expect(screen.getByTestId('settings-dialog')).toBeDefined();
      await waitFor(() => expect(document.activeElement).toBe(input));
      await userEvent.keyboard('[Escape]');
      await waitFor(() => expect(screen.queryByTestId('settings-dialog')).toBeNull());
    },
  );

  beforeEach(() => {
    setHost(null);
    probeActiveIds.length = 0;
    showSpellingRow = false;
  });
  afterEach(() => {
    cleanup();
    setHost(null);
  });

  test.each(['win32', 'linux'] as const)(
    'searching spellcheck on %s reaches both spelling controls in user Preferences',
    async (platform) => {
      setHost(platform);
      const user = userEvent.setup();
      render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

      await searchSpellcheck(user);
      const toggle = await screen.findByTestId(TOGGLE_RESULT_ID);
      expect(screen.getByTestId(LANGUAGES_RESULT_ID)).toBeDefined();

      await user.click(toggle);
      expect(probeActiveIds.at(-1)).toBe('preferences');
    },
  );

  test('navigating to the languages entry anchors its block, not just the page', async () => {
    setHost('win32');
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await searchSpellcheck(user);
    await user.click(await screen.findByTestId(LANGUAGES_RESULT_ID));

    expect(probeActiveIds.at(-1)).toBe('preferences');
    await waitFor(() => {
      expect(
        screen
          .getByTestId('probe-spellcheck-languages-block')
          .classList.contains('animate-settings-nav-flash'),
      ).toBe(true);
    });
  });

  test('macOS surfaces the toggle entry and no checking-language entry', async () => {
    setHost('darwin');
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await searchSpellcheck(user);
    expect(await screen.findByTestId(TOGGLE_RESULT_ID)).toBeDefined();
    expect(screen.queryByTestId(LANGUAGES_RESULT_ID)).toBeNull();
  });

  test('a browser host surfaces no desktop spelling entry at all', async () => {
    setHost(null);
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await searchSpellcheck(user);
    await waitFor(() => {
      expect(screen.getByTestId('settings-search-empty')).toBeDefined();
    });
    expect(screen.queryByTestId(TOGGLE_RESULT_ID)).toBeNull();
    expect(screen.queryByTestId(LANGUAGES_RESULT_ID)).toBeNull();
  });

  test('the spelling entries stay search-only and leave the user sidebar items unchanged', () => {
    setHost('win32');
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(screen.queryByTestId('settings-sidebar-item-spellcheck')).toBeNull();
    expect(screen.queryByTestId('settings-sidebar-item-spellcheck-languages')).toBeNull();
    for (const id of ['preferences', 'hotkeys', 'account', 'user-plugins-manage', 'user-skills']) {
      expect(screen.getByTestId(`settings-sidebar-item-${id}`)).toBeDefined();
    }
  });
});
