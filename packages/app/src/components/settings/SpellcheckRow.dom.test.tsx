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
import type { OkSpellcheckEnabledSetResult } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastError = vi.fn(() => {});
vi.doMock('sonner', () => ({
  toast: { error: toastError, info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { SpellcheckRow } = await import('./SpellcheckRow');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { describedTextOf } = await import('./settings-a11y.test-helper');

function render(ui: ReactNode) {
  return renderWithTestingLibrary(ui, { wrapper: TooltipProvider });
}

interface BridgeOptions {
  readonly query?: () => Promise<{ spellCheckEnabled: boolean } | undefined>;
  readonly setEnabled?: (enabled: boolean) => Promise<OkSpellcheckEnabledSetResult>;
  readonly omitMenu?: boolean;
}

function installBridge(options: BridgeOptions = {}) {
  const enabledCalls: boolean[] = [];
  const languageCalls: readonly string[][] = [];
  const bridge = {
    menu: options.omitMenu
      ? undefined
      : {
          dispatch: options.query ?? (async () => ({ spellCheckEnabled: false })),
        },
    spellcheck: {
      setEnabled: async (enabled: boolean) => {
        enabledCalls.push(enabled);
        return options.setEnabled
          ? await options.setEnabled(enabled)
          : ({ kind: 'spellcheck-enabled-set', ok: true, enabled, saved: true } as const);
      },
      setLanguages: async (languages: readonly string[]) => {
        (languageCalls as string[][]).push([...languages]);
        return { kind: 'spelling-languages-set', ok: true, state: { available: [], selected: [] } };
      },
    },
  };
  Object.defineProperty(window, 'okDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return { enabledCalls, languageCalls };
}

afterEach(() => {
  cleanup();
  toastError.mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: test-only global teardown.
  (window as any).okDesktop = undefined;
});

describe('SpellcheckRow', () => {
  test.each(['toggle', 'reset'])('%s briefly confirms a saved change', async (action) => {
    installBridge();
    render(<SpellcheckRow />);
    const toggle = await screen.findByRole('switch');
    expect(screen.queryByText('Saved')).toBeNull();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        fireEvent.click(
          action === 'toggle'
            ? toggle
            : screen.getByRole('button', { name: 'Reset Check spelling while typing to default' }),
        );
      });
      expect(screen.getByRole('status').textContent).toBe('Saved');
      act(() => vi.advanceTimersByTime(1200));
      expect(screen.getByRole('status').textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  test('reset restores spell checking to on without changing the selected languages', async () => {
    const { enabledCalls, languageCalls } = installBridge();

    render(<SpellcheckRow />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Reset Check spelling while typing to default' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('data-state')).toBe('checked'),
    );
    expect(enabledCalls).toEqual([true]);
    expect(languageCalls).toEqual([]);
  });

  test('shows the current shared spellcheck state once it has been read', async () => {
    installBridge({ query: async () => ({ spellCheckEnabled: true }) });

    render(<SpellcheckRow />);

    const toggle = await screen.findByTestId('settings-spellcheck-toggle');
    expect(toggle.getAttribute('data-state')).toBe('checked');
  });

  test('turning it on asks the host for on, and turning it off asks for off', async () => {
    const { enabledCalls } = installBridge({ query: async () => ({ spellCheckEnabled: false }) });

    render(<SpellcheckRow />);

    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));
    await waitFor(() => expect(enabledCalls).toEqual([true]));

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
        'checked',
      ),
    );

    await userEvent.click(screen.getByTestId('settings-spellcheck-toggle'));
    await waitFor(() => expect(enabledCalls).toEqual([true, false]));
  });

  test('turning it off leaves the configured checking languages alone', async () => {
    const { languageCalls } = installBridge({ query: async () => ({ spellCheckEnabled: true }) });

    render(<SpellcheckRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
        'unchecked',
      ),
    );
    expect(languageCalls).toEqual([]);
  });

  test('reflects the value the host actually applied rather than the one that was asked for', async () => {
    installBridge({
      query: async () => ({ spellCheckEnabled: false }),
      setEnabled: async () => ({
        kind: 'spellcheck-enabled-set',
        ok: true,
        enabled: false,
        saved: true,
      }),
    });

    render(<SpellcheckRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));

    await waitFor(() => expect(toastError).not.toHaveBeenCalled());
    expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  test('a refused change is reported and is not shown as applied', async () => {
    installBridge({
      query: async () => ({ spellCheckEnabled: false }),
      setEnabled: async () => ({
        kind: 'spellcheck-enabled-set',
        ok: false,
        reason: 'engine-error',
      }),
    });

    render(<SpellcheckRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toContain("Couldn't change spell checking");
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  test('a change the host could not save reports the failure and still shows what is running', async () => {
    installBridge({
      query: async () => ({ spellCheckEnabled: false }),
      setEnabled: async (enabled) => ({
        kind: 'spellcheck-enabled-set',
        ok: true,
        enabled,
        saved: false,
      }),
    });

    render(<SpellcheckRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).toContain("won't apply after a restart");
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
      'checked',
    );
  });

  test('a host that rejects the change is reported rather than swallowed', async () => {
    const error = new Error('ipc channel closed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installBridge({
      query: async () => ({ spellCheckEnabled: false }),
      setEnabled: async () => {
        throw error;
      },
    });

    render(<SpellcheckRow />);
    await userEvent.click(await screen.findByTestId('settings-spellcheck-toggle'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(warning).toHaveBeenCalledWith('[SpellcheckRow] Could not change spell checking state', {
      enabled: true,
      error,
    });
    expect(screen.getByTestId('settings-spellcheck-toggle').getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  test('offers no switch to act on while the current state is still being read', async () => {
    installBridge({ query: () => new Promise(() => {}) });

    render(<SpellcheckRow />);

    expect(await screen.findByTestId('settings-spellcheck-row')).not.toBeNull();
    expect(screen.queryByTestId('settings-spellcheck-toggle')).toBeNull();
    expect(screen.getByTestId('settings-spellcheck-body').textContent).toContain(
      'Reading the current setting',
    );
  });

  test('a read that fails says so instead of inventing a value', async () => {
    installBridge({
      query: async () => {
        throw new Error('ipc channel closed');
      },
    });

    render(<SpellcheckRow />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-body').textContent).toContain(
        "Couldn't read the spell checking setting",
      ),
    );
    expect(screen.queryByTestId('settings-spellcheck-toggle')).toBeNull();
  });

  test('a host with no menu surface to read from shows the read error', async () => {
    installBridge({ omitMenu: true });

    render(<SpellcheckRow />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-spellcheck-body').textContent).toContain(
        "Couldn't read the spell checking setting",
      ),
    );
  });

  test('renders nothing without the desktop bridge', async () => {
    render(<SpellcheckRow />);
    await waitFor(() => expect(screen.queryByTestId('settings-spellcheck-row')).toBeNull());
  });

  test('the switch is named and described for assistive technology', async () => {
    installBridge({ query: async () => ({ spellCheckEnabled: true }) });

    render(<SpellcheckRow />);

    const toggle = await screen.findByTestId('settings-spellcheck-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Check spelling while typing');
    expect(describedTextOf('settings-spellcheck-toggle')).toContain('Underlines misspelled words');
  });

  test('the switch is operable from the keyboard', async () => {
    const { enabledCalls } = installBridge({ query: async () => ({ spellCheckEnabled: false }) });

    render(<SpellcheckRow />);

    const toggle = await screen.findByTestId('settings-spellcheck-toggle');
    toggle.focus();
    await userEvent.keyboard('[Space]');

    await waitFor(() => expect(enabledCalls).toEqual([true]));
  });
});
