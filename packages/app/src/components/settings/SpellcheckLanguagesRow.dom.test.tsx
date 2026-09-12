import * as actualLinguiMacro from '@lingui/react/macro';
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  OkSpellingLanguagesQueryResult,
  OkSpellingLanguagesSetResult,
} from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

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
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { SpellcheckLanguagesRow } = await import('./SpellcheckLanguagesRow');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function render(ui: ReactNode) {
  return renderWithTestingLibrary(ui, { wrapper: TooltipProvider });
}

interface BridgeOptions {
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly languages?: () => Promise<OkSpellingLanguagesQueryResult>;
  readonly setLanguages?: (languages: readonly string[]) => Promise<OkSpellingLanguagesSetResult>;
}

function installBridge(options: BridgeOptions = {}) {
  const submitted: string[][] = [];
  const bridge = {
    platform: options.platform ?? 'win32',
    spellcheck: {
      languages:
        options.languages ??
        (async () =>
          ({
            kind: 'spelling-languages-query',
            ok: true,
            state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US'], defaults: ['en-US'] },
          }) as const),
      setLanguages: async (languages: readonly string[]) => {
        submitted.push([...languages]);
        return options.setLanguages
          ? await options.setLanguages(languages)
          : ({
              kind: 'spelling-languages-set',
              ok: true,
              state: {
                available: ['en-US', 'vi', 'fr'],
                selected: [...languages],
                defaults: ['en-US'],
              },
            } as const);
      },
    },
  };
  Object.defineProperty(window, 'okDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return { submitted };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toastError.mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('SpellcheckLanguagesRow', () => {
  test.each(['selection', 'reset'])('%s briefly confirms a saved change', async (action) => {
    installBridge();
    render(<SpellcheckLanguagesRow />);
    const trigger = await screen.findByRole('combobox');
    if (action === 'selection') {
      await userEvent.click(trigger);
      await screen.findByRole('listbox');
    }
    expect(screen.queryByText('Saved')).toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        fireEvent.click(
          action === 'selection'
            ? screen.getByTestId('settings-spellcheck-language-item-vi')
            : screen.getByRole('button', { name: 'Reset Spelling languages to default' }),
        );
      });
      const savedStatus = screen.getByText('Saved').closest('[role="status"]');
      expect(savedStatus).not.toBeNull();
      expect(savedStatus?.textContent).toBe('Saved');
      act(() => vi.advanceTimersByTime(1200));
      expect(savedStatus?.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('reset restores the host default rather than the saved selection or interface language', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US', 'vi'], defaults: ['fr'] },
      }),
    });
    render(<SpellcheckLanguagesRow />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reset Spelling languages to default' }),
    );
    await waitFor(() => expect(submitted).toEqual([['fr']]));
    expect(screen.getByTestId('settings-spellcheck-languages-trigger').textContent).toContain(
      'French',
    );
  });

  test('shows the languages the engine reports as selected, and adds none of its own', async () => {
    installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US', 'fr'], defaults: ['en-US'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);

    const trigger = await screen.findByTestId('settings-spellcheck-languages-trigger');
    expect(trigger.textContent).toContain('American English');
    expect(trigger.textContent).toContain('French');
    expect(trigger.textContent).not.toContain('Vietnamese');
  });

  test('the picker offers the languages the engine supports', async () => {
    installBridge();

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');

    expect(screen.getByTestId('settings-spellcheck-language-item-vi').textContent).toContain(
      'Vietnamese',
    );
    expect(screen.getByTestId('settings-spellcheck-language-item-fr').textContent).toContain(
      'French',
    );
  });

  test('adding a language submits the whole replacement selection', async () => {
    const { submitted } = installBridge();

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() => expect(submitted).toEqual([['en-US', 'vi']]));
  });

  test('reflects the selection the host applied rather than the one that was asked for', async () => {
    installBridge({
      setLanguages: async () => ({
        kind: 'spelling-languages-set',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US'], defaults: ['en-US'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-languages-trigger').textContent).not.toContain(
        'Vietnamese',
      ),
    );
  });

  test('removing a language that is not the last one submits the remainder', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US', 'vi'], defaults: ['en-US'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() => expect(submitted).toEqual([['en-US']]));
  });

  test('selected languages have removable chips and an inline search input', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi'], selected: ['en-US', 'vi'], defaults: ['en-US'] },
      }),
    });
    render(<SpellcheckLanguagesRow />);
    const chips = await screen.findByRole('toolbar', { name: 'Spelling languages' });
    const input = screen.getByRole('combobox', { name: 'Spelling languages' });
    expect(chips.contains(input)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Vietnamese' }));
    await waitFor(() => expect(submitted).toEqual([['en-US']]));
    expect(chips.textContent).not.toContain('Vietnamese');
    expect(screen.queryByRole('button', { name: 'Remove American English' })).toBeNull();
    expect(screen.getByText('Saved')).not.toBeNull();
  });

  test('Backspace removes a chip but cannot remove the final language', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi'], selected: ['en-US', 'vi'], defaults: ['en-US'] },
      }),
    });
    render(<SpellcheckLanguagesRow />);
    const input = await screen.findByRole('combobox', { name: 'Spelling languages' });
    await userEvent.click(input);
    await userEvent.keyboard('[Escape][Backspace]');
    await waitFor(() => expect(submitted).toEqual([['en-US']]));
    await userEvent.keyboard('[Backspace][Delete]');
    expect(submitted).toEqual([['en-US']]);
    expect(screen.getByRole('toolbar').textContent).toContain('American English');
  });

  test('the last remaining language cannot be removed', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US'], defaults: ['en-US'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-en-US'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-languages-trigger').textContent).toContain(
        'American English',
      ),
    );
    expect(submitted).toEqual([]);
  });

  test('a refused change is reported and the selection is left as it was', async () => {
    installBridge({
      setLanguages: async () => ({
        kind: 'spelling-languages-set',
        ok: false,
        reason: 'engine-error',
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toContain("Couldn't change the spelling languages");
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByTestId('settings-spellcheck-languages-trigger').textContent).not.toContain(
      'Vietnamese',
    );
  });

  test('a language the engine will not accept says so rather than telling the user to retry', async () => {
    installBridge({
      setLanguages: async () => ({
        kind: 'spelling-languages-set',
        ok: false,
        reason: 'unsupported-language',
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toContain("isn't available for spell checking");
    expect(screen.queryByText('Saved')).toBeNull();
  });

  test('a host that rejects the change is reported rather than swallowed', async () => {
    const error = new Error('ipc channel closed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installBridge({
      setLanguages: async () => {
        throw error;
      },
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await userEvent.click(screen.getByTestId('settings-spellcheck-language-item-vi'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      '[SpellcheckLanguagesRow] Changing spelling languages failed',
      { languages: ['en-US', 'vi'], error },
    );
    expect(screen.getByTestId('settings-spellcheck-languages-trigger').textContent).not.toContain(
      'Vietnamese',
    );
  });

  test('offers nothing to pick from while the configured selection is still being read', async () => {
    installBridge({ languages: () => new Promise(() => {}) });

    render(<SpellcheckLanguagesRow />);

    expect(await screen.findByTestId('settings-spellcheck-languages-row')).not.toBeNull();
    expect(screen.queryByTestId('settings-spellcheck-languages-trigger')).toBeNull();
    expect(screen.getByTestId('settings-spellcheck-languages-body').textContent).toContain(
      'Reading the current languages',
    );
  });

  test('a read that fails says so instead of inventing preference values', async () => {
    installBridge({
      languages: async () => {
        throw new Error('ipc channel closed');
      },
    });

    render(<SpellcheckLanguagesRow />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-languages-body').textContent).toContain(
        "Couldn't read the spelling languages",
      ),
    );
    expect(screen.queryByTestId('settings-spellcheck-languages-trigger')).toBeNull();
  });

  test('a read the engine refuses says so instead of inventing preference values', async () => {
    installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: false,
        reason: 'engine-error',
      }),
    });

    render(<SpellcheckLanguagesRow />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-languages-body').textContent).toContain(
        "Couldn't read the spelling languages",
      ),
    );
  });

  test('explains the download wait and the stale-underline caveat without promising a refresh', async () => {
    installBridge();

    render(<SpellcheckLanguagesRow />);

    const row = await screen.findByTestId('settings-spellcheck-languages-row');
    expect(row.textContent).toContain(
      'New languages may need an internet connection and time to become available.',
    );
    expect(row.textContent).toContain('Existing underlines may not update immediately.');
    expect(row.textContent).not.toMatch(/restart|reopen|wait/i);
    expect(row.textContent).not.toMatch(/\bReady\b|downloaded|Automatic/);
  });

  test('renders nothing on a macOS host', async () => {
    installBridge({ platform: 'darwin' });

    render(<SpellcheckLanguagesRow />);
    await waitFor(() =>
      expect(screen.queryByTestId('settings-spellcheck-languages-row')).toBeNull(),
    );
  });

  test('renders nothing in a browser', async () => {
    render(<SpellcheckLanguagesRow />);
    await waitFor(() =>
      expect(screen.queryByTestId('settings-spellcheck-languages-row')).toBeNull(),
    );
  });

  test('a language code the platform cannot name still shows its code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['not a tag', 'vi'], selected: ['vi'], defaults: ['vi'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');

    expect(screen.getByTestId('settings-spellcheck-language-item-not a tag').textContent).toContain(
      'not a tag',
    );
    expect(screen.getByTestId('settings-spellcheck-language-item-vi').textContent).toContain(
      'Vietnamese',
    );
    expect(warn).toHaveBeenCalledWith(
      '[SpellcheckLanguagesRow] Naming a spelling language failed',
      expect.objectContaining({
        code: 'not a tag',
        locale: expect.any(String),
        error: expect.any(RangeError),
      }),
    );
  });

  test('the picker is named and operable from the keyboard', async () => {
    const { submitted } = installBridge();

    render(<SpellcheckLanguagesRow />);

    const trigger = await screen.findByRole('combobox', { name: 'Spelling languages' });
    const labelledBy = trigger.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('Spelling languages');
    expect(
      document.getElementById(trigger.getAttribute('aria-describedby') as string)?.textContent,
    ).toContain('New languages may need an internet connection');

    trigger.focus();
    await userEvent.keyboard('[ArrowDown]');
    const item = await screen.findByTestId('settings-spellcheck-language-item-vi');
    expect(item.getAttribute('aria-selected')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    const input = trigger;
    expect(
      screen.queryByText('Keep at least one language. Turn spell checking off instead.'),
    ).toBeNull();
    await userEvent.type(input, 'Vietnamese');
    await userEvent.keyboard('[ArrowDown][Enter]');
    await waitFor(() => expect(submitted).toEqual([['en-US', 'vi']]));
    await userEvent.keyboard('[Escape]');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('an empty native selection invites a choice without inventing a language', async () => {
    const { submitted } = installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi'], selected: [], defaults: ['en-US'] },
      }),
    });
    render(<SpellcheckLanguagesRow />);
    const trigger = await screen.findByTestId('settings-spellcheck-languages-trigger');
    expect(screen.getByRole('combobox').getAttribute('placeholder')).toBe(
      'Select spelling languages',
    );
    await userEvent.click(trigger);
    await screen.findByRole('listbox');
    expect(
      screen.getAllByRole('option').every((item) => item.getAttribute('aria-selected') === 'false'),
    ).toBe(true);
    await userEvent.click(screen.getByRole('option', { name: /Vietnamese/ }));
    await waitFor(() => expect(submitted).toEqual([['vi']]));
  });

  test('a nonmatching search is distinct from no available languages and clearing restores options', async () => {
    const { submitted } = installBridge();
    render(<SpellcheckLanguagesRow />);
    const input = await screen.findByRole('combobox', { name: 'Spelling languages' });
    await userEvent.type(input, 'zzzzzz');
    expect(await screen.findByText('No languages match.')).toBeDefined();
    expect(screen.queryByTestId('settings-spellcheck-languages-empty')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await userEvent.clear(input);
    await screen.findByRole('option', { name: /Vietnamese/ });
    expect(screen.queryByText('No languages match.')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(submitted).toEqual([]);
  });

  test('an empty available list explains that there is nothing to select', async () => {
    installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: [], selected: [], defaults: [] },
      }),
    });
    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    expect(
      (await screen.findByTestId('settings-spellcheck-languages-empty')).textContent,
    ).toContain('No spelling languages are available.');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  test('shows the selected languages as checked and the rest as unchecked', async () => {
    installBridge({
      languages: async () => ({
        kind: 'spelling-languages-query',
        ok: true,
        state: { available: ['en-US', 'vi', 'fr'], selected: ['en-US', 'vi'], defaults: ['en-US'] },
      }),
    });

    render(<SpellcheckLanguagesRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-languages-trigger'));
    await screen.findByRole('listbox');
    await screen.findByTestId('settings-spellcheck-language-item-vi');

    expect(
      screen.getByTestId('settings-spellcheck-language-item-vi').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('settings-spellcheck-language-item-fr').getAttribute('aria-selected'),
    ).toBe('false');
    const input = screen.getByRole('combobox', { name: 'Spelling languages' });
    const list = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    await userEvent.keyboard('[ArrowDown]');
    expect(screen.getByRole('option', { name: /Vietnamese/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: /French/ }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getAllByRole('option').every((item) => !item.hasAttribute('aria-checked'))).toBe(
      true,
    );
  });
});
