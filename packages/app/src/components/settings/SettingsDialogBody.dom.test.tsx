import {
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  type ConfigPatch,
  ConfigSchema,
  LAYOUT_DEFERRED_LOCALES,
  PICKER_LOCALES,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { emitConfigValidationRejected } from '@/lib/config-validation-events';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { SettingsDialogBody } from './SettingsDialogBody';

/** Drop every `null` leaf — the patch spelling for "delete this key". */
function stripNulls(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, stripNulls(v)]),
  );
}

function makeBinding(config: Config = ConfigSchema.parse({})): {
  binding: ConfigBinding;
  patches: ConfigPatch[];
} {
  const patches: ConfigPatch[] = [];
  const binding: ConfigBinding = {
    current: () => config,
    patch: (patch: ConfigPatch) => {
      patches.push(patch);
      return {
        ok: true,
        // `null` means "clear this key" in a real patch (the binding deletes it
        // before validating), so drop nulls rather than handing them to Zod.
        effective: ConfigSchema.parse({ ...config, ...stripNulls(patch) }),
        appliedPaths: ['editor.wordWrap'],
      };
    },
    subscribe: () => () => {},
    hasSynced: () => true,
    subscribeSynced: (listener) => {
      queueMicrotask(listener);
      return () => {};
    },
    dispose: () => {},
  };
  return { binding, patches };
}

/** A binding that rejects every write, for the error-routing path. */
function makeRejectingBinding(config: Config = ConfigSchema.parse({})): ConfigBinding {
  return {
    current: () => config,
    patch: () => ({
      ok: false,
      error: {
        code: 'SCHEMA_INVALID',
        message: 'config rejected',
        issues: [{ path: ['appearance', 'colorThemeLight'], message: 'palette write rejected' }],
      },
    }),
    subscribe: () => () => {},
    hasSynced: () => true,
    subscribeSynced: (listener) => {
      queueMicrotask(listener);
      return () => {};
    },
    dispose: () => {},
  } as unknown as ConfigBinding;
}

function makeConfigContextValue(
  projectBinding: ConfigBinding = makeBinding().binding,
  userBinding: ConfigBinding | null = null,
) {
  const config = ConfigSchema.parse({});
  return {
    userBinding,
    userSynced: true,
    projectBinding,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: true,
    userConfig: config,
    projectConfig: config,
    projectSynced: true,
    projectLocalConfig: config,
    projectLocalSynced: true,
    merged: config,
  } satisfies ConfigContextValue;
}

function SettingsContextProvider({
  children,
  userBinding = null,
}: {
  children: ReactNode;
  userBinding?: ConfigBinding | null;
}) {
  return (
    <ConfigContext value={makeConfigContextValue(undefined, userBinding)}>{children}</ConfigContext>
  );
}

function renderPreferences(binding: ConfigBinding) {
  return render(
    <SettingsContextProvider>
      <TooltipProvider>
        <SettingsDialogBody
          activeId="preferences"
          userBinding={binding}
          okignoreBinding={null}
          okignoreSynced={false}
        />
      </TooltipProvider>
    </SettingsContextProvider>,
  );
}

describe('SettingsDialogBody preferences runtime', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders editor.wordWrap in the Preferences section', () => {
    const { binding } = makeBinding();
    const { container } = renderPreferences(binding);

    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeDefined();
    expect(screen.getByText('Word wrap')).toBeDefined();
    expect(screen.getByText('Wrap long lines in the markdown source editor.')).toBeDefined();
    const field = container.querySelector('[data-field="editor.wordWrap"]');
    expect(field).toBeTruthy();
    expect(field?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');

    expect(screen.getByText('Preview tabs')).toBeDefined();
    expect(
      screen.getByText(
        'Reuse one tab when clicking through the sidebars. Off opens every click in its own tab.',
      ),
    ).toBeDefined();
    const previewTabsField = container.querySelector('[data-field="editor.previewTabs"]');
    expect(previewTabsField).toBeTruthy();
    expect(previewTabsField?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );

    expect(screen.getByText('Open preview when agent edits')).toBeDefined();
    expect(
      screen.getByText(
        'When enabled, the agent opens or refreshes the preview after each edit. Disable if you manage your own preview window (OK Desktop, a browser tab on another display, etc.).',
      ),
    ).toBeDefined();
    const previewField = container.querySelector('[data-field="appearance.preview.autoOpen"]');
    expect(previewField).toBeTruthy();
    expect(previewField?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  test('commits editor.wordWrap changes through binding.patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    renderPreferences(binding);

    const wordWrapSwitch = screen.getByRole('switch', { name: 'Word wrap' });
    await user.click(wordWrapSwitch);

    await waitFor(() => {
      expect(patches).toEqual([{ editor: { wordWrap: false } }]);
    });
    expect(wordWrapSwitch.getAttribute('aria-checked')).toBe('false');
  });

  test('commits editor.previewTabs changes through binding.patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    renderPreferences(binding);

    const previewTabsSwitch = screen.getByRole('switch', { name: 'Preview tabs' });
    await user.click(previewTabsSwitch);

    await waitFor(() => {
      expect(patches).toEqual([{ editor: { previewTabs: false } }]);
    });
    expect(previewTabsSwitch.getAttribute('aria-checked')).toBe('false');
  });

  test('commits appearance.preview.autoOpen changes through binding.patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    renderPreferences(binding);

    const autoOpenSwitch = screen.getByRole('switch', { name: 'Open preview when agent edits' });
    expect(autoOpenSwitch.getAttribute('aria-checked')).toBe('true');

    await user.click(autoOpenSwitch);

    await waitFor(() => {
      expect(patches).toEqual([{ appearance: { preview: { autoOpen: false } } }]);
    });
    expect(autoOpenSwitch.getAttribute('aria-checked')).toBe('false');

    await user.click(autoOpenSwitch);

    await waitFor(() => {
      expect(patches).toEqual([
        { appearance: { preview: { autoOpen: false } } },
        { appearance: { preview: { autoOpen: true } } },
      ]);
    });
    expect(autoOpenSwitch.getAttribute('aria-checked')).toBe('true');
  });

  test('surfaces L3 config-validation rejections on the matching user field', async () => {
    const { binding } = makeBinding();
    const { container } = renderPreferences(binding);

    const wordWrapField = container.querySelector('[data-field="editor.wordWrap"]');
    expect(wordWrapField).toBeTruthy();

    act(() => {
      emitConfigValidationRejected({
        v: 1,
        ch: 'config-validation-rejected',
        seq: 1,
        docName: CONFIG_DOC_NAME_USER,
        error: {
          code: 'SCHEMA_INVALID',
          issues: [
            {
              path: ['editor', 'wordWrap'],
              message: 'Expected boolean',
              issueCode: 'invalid_type',
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-field-error="editor.wordWrap"]')?.textContent).toBe(
        'Expected boolean',
      );
    });
    expectVisualClassTokens(wordWrapField?.className, ['animate-settings-flash']);
  });

  test('surfaces L3 config-validation rejections on the project attachment field', async () => {
    const { binding } = makeBinding();
    const { container } = renderPreferences(binding);

    const attachmentField = container.querySelector('[data-field="content.attachmentFolderPath"]');
    expect(attachmentField).toBeTruthy();

    act(() => {
      emitConfigValidationRejected({
        v: 1,
        ch: 'config-validation-rejected',
        seq: 2,
        docName: CONFIG_DOC_NAME_PROJECT,
        error: {
          code: 'SCHEMA_INVALID',
          issues: [
            {
              path: ['content', 'attachmentFolderPath'],
              message: 'Invalid attachment folder path',
              issueCode: 'invalid_path',
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId('settings-attachments')).getByRole('alert').textContent,
      ).toBe('Invalid attachment folder path');
    });
    expectVisualClassTokens(attachmentField?.className, ['animate-settings-flash']);
  });
});

/**
 * Radix opens the listbox from the keyboard as well as from a pointer, and the
 * keyboard path needs none of the pointer-capture APIs jsdom leaves out.
 */
async function openLanguagePicker(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('combobox', { name: 'Language' });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  await waitFor(() => {
    expect(screen.getByRole('listbox')).toBeDefined();
  });
}

describe('SettingsDialogBody language picker', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders a Language row beside Theme, showing the stored preference', () => {
    const config = ConfigSchema.parse({ appearance: { language: 'es' } });
    const { binding } = makeBinding(config);
    const { container } = renderPreferences(binding);

    expect(screen.getByRole('combobox', { name: 'Language' }).textContent).toContain('español');
    const fields = [...container.querySelectorAll('[data-field]')].map((el) =>
      el.getAttribute('data-field'),
    );
    expect(fields.indexOf('appearance.language')).toBe(fields.indexOf('appearance.theme') + 1);
  });

  test('names each language in itself, and offers none that is held back', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    renderPreferences(binding);

    await openLanguagePicker(user);

    // Named in their own language, so someone who cannot read the language on
    // screen can still find theirs. Membership is the sibling test below; this
    // one is about what the rows say.
    const names = screen.getAllByRole('option').map((el) => el.textContent);
    expect(names[0]).toBe('System');
    expect(names).toContain('简体中文');
    expect(names).toContain('português (Brasil)');

    // The two right-to-left locales are enumerated and complete, and must stay
    // unreachable from here while the chrome's layout for them is unfinished.
    for (const locale of LAYOUT_DEFERRED_LOCALES) {
      const endonym = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
      expect(screen.queryByRole('option', { name: endonym })).toBeNull();
    }
  });

  test('derives its locale options from the offered set in core', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    renderPreferences(binding);

    await openLanguagePicker(user);

    // Reading back the `lang` each option carries pins both the derivation and
    // the tag assistive tech pronounces the name with. `null` is the System
    // row, which names no language.
    const tags = screen
      .getAllByRole('option')
      .map((el) => el.querySelector('[lang]')?.getAttribute('lang') ?? null);
    expect(tags).toEqual([null, ...PICKER_LOCALES]);
  });

  test('commits the picked language through binding.patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    renderPreferences(binding);

    await openLanguagePicker(user);
    await user.click(screen.getByRole('option', { name: 'español' }));

    await waitFor(() => {
      expect(patches).toEqual([{ appearance: { language: 'es' } }]);
    });
  });

  test('picking System stores the sentinel rather than a resolved locale', async () => {
    const user = userEvent.setup();
    const config = ConfigSchema.parse({ appearance: { language: 'es' } });
    const { binding, patches } = makeBinding(config);
    renderPreferences(binding);

    await openLanguagePicker(user);
    await user.click(screen.getByRole('option', { name: 'System' }));

    await waitFor(() => {
      expect(patches).toEqual([{ appearance: { language: 'system' } }]);
    });
  });

  test('a hand-set withheld locale still shows, without becoming an option', async () => {
    const user = userEvent.setup();
    const config = ConfigSchema.parse({ appearance: { language: 'ar' } });
    const { binding } = makeBinding(config);
    renderPreferences(binding);

    // The trigger renders its own label rather than mirroring a selected item,
    // which is what keeps a preference the picker does not list from showing as
    // an empty control.
    expect(screen.getByRole('combobox', { name: 'Language' }).textContent).toContain('العربية');

    await openLanguagePicker(user);
    expect(screen.queryByRole('option', { name: 'العربية' })).toBeNull();
  });
});

/**
 * Optimistic theme-apply path. The Theme ToggleGroup must flip
 * next-themes immediately on the originating client instead of waiting for
 * the patch -> user-config Y.Text -> ConfigProvider merged-effect round-trip.
 *
 * This harness mounts no ConfigProvider effects; it only supplies the bare
 * ConfigContext needed by project-scope settings. The only thing that can move
 * next-themes state on click is still the optimistic `setTheme(next)` wired
 * into `FieldControlBody`'s enum-toggle branch. That makes the probe assertion
 * a discriminating check: it goes green ONLY if the optimistic path fires. The
 * `binding.patch` assertion proves persistence is still wired.
 */
let themeStorageKeySeq = 0;

function ThemeProbe() {
  const { theme } = useTheme();
  return <span data-testid="theme-probe">{theme ?? ''}</span>;
}

function renderPreferencesWithTheme(binding: ConfigBinding) {
  // Unique storageKey per render so next-themes can't carry a persisted
  // value from a prior test in this file (defaultTheme="system" each time).
  themeStorageKeySeq += 1;
  return render(
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey={`ok-theme-v1-test-${themeStorageKeySeq}`}
    >
      <SettingsContextProvider>
        <TooltipProvider>
          <SettingsDialogBody
            activeId="preferences"
            userBinding={binding}
            okignoreBinding={null}
            okignoreSynced={false}
          />
          <ThemeProbe />
        </TooltipProvider>
      </SettingsContextProvider>
    </ThemeProvider>,
  );
}

/**
 * What each theme value reads as on screen. The toggle renders a translated
 * label rather than the config value, so the value alone no longer finds the
 * control; under this runner the Lingui macros pass English through, which is
 * what these are. Kept as a lookup so the call sites stay written in terms of
 * the value they go on to assert against.
 */
const THEME_OPTION_LABELS: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

function themeToggleItem(container: HTMLElement, option: string): HTMLElement {
  const field = container.querySelector('[data-field="appearance.theme"]');
  if (!field) throw new Error('appearance.theme field not rendered');
  return within(field as HTMLElement).getByText(THEME_OPTION_LABELS[option] ?? option);
}

describe('SettingsDialogBody theme toggle — optimistic apply', () => {
  afterEach(() => {
    cleanup();
  });

  test('clicking Dark flips next-themes immediately and still persists via binding.patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    const { container } = renderPreferencesWithTheme(binding);

    // Default theme before any click.
    expect(screen.getByTestId('theme-probe').textContent).toBe('system');

    await user.click(themeToggleItem(container, 'dark'));

    // Optimistic flip — observable only via the new setTheme path because
    // this tree has no ConfigProvider merged-effect to drive the theme.
    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('dark');
    });
    // Persistence to user-scope config.yml still wired (nested patch shape).
    expect(patches).toEqual([{ appearance: { theme: 'dark' } }]);
  });

  test("clicking System forwards 'system' verbatim to next-themes (does not resolve to light/dark)", async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    const { container } = renderPreferencesWithTheme(binding);

    // Move off the default first so the System transition is observable.
    await user.click(themeToggleItem(container, 'dark'));
    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('dark');
    });

    await user.click(themeToggleItem(container, 'system'));

    // Verbatim 'system' — the OS-tracking lever — not a resolved light/dark.
    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('system');
    });
    expect(patches.at(-1)).toEqual({ appearance: { theme: 'system' } });
  });

  test('clicking Light flips to light and records the patch', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    const { container } = renderPreferencesWithTheme(binding);

    await user.click(themeToggleItem(container, 'light'));

    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('light');
    });
    expect(patches).toEqual([{ appearance: { theme: 'light' } }]);
  });
});

/**
 * The color-palette picker (Settings → Plugins → Themes) optimistically flips
 * next-themes to the palette's FORCED mode, not merely "dark or nothing". A
 * light-kind built-in (Catppuccin Latte) must flip to light so the `.dark`
 * class drops in the same tick the light palette paints — otherwise Tailwind
 * `dark:` variants coexist with the light palette until the config round-trips,
 * a flash of dark-on-light. Same harness/probe rationale as the toggle tests
 * above: with no ConfigProvider effect mounted, only the optimistic
 * `setTheme(colorThemeMode(next))` path can move the probe.
 */
function renderThemePluginWithTheme(binding: ConfigBinding) {
  themeStorageKeySeq += 1;
  return render(
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey={`ok-theme-v1-test-${themeStorageKeySeq}`}
    >
      <SettingsContextProvider userBinding={binding}>
        <TooltipProvider>
          <SettingsDialogBody
            activeId="plugin:theme"
            userBinding={binding}
            okignoreBinding={null}
            okignoreSynced={false}
          />
          <ThemeProbe />
        </TooltipProvider>
      </SettingsContextProvider>
    </ThemeProvider>,
  );
}

describe('SettingsDialogBody color-palette picker — optimistic mode flip', () => {
  afterEach(() => {
    cleanup();
  });

  test('the Themes plugin header shows a User scope badge (user-scope plugin)', () => {
    const { binding } = makeBinding();
    renderThemePluginWithTheme(binding);
    expect(screen.getByTestId('settings-scope-badge-user')).toBeDefined();
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
  });

  test('assigning a palette to the mode on screen applies it immediately', async () => {
    // jsdom reports no dark preference, so the mode on screen is light and the
    // sun is the icon that changes what the user sees right now.
    const user = userEvent.setup();
    const { binding } = makeBinding();
    renderThemePluginWithTheme(binding);

    expect(screen.getByTestId('theme-probe').textContent).toBe('system');

    await user.click(screen.getByLabelText('Use Catppuccin Latte as the light theme'));

    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('light');
    });
  });

  test('a cross-variant palette in the on-screen slot forces its own mode', async () => {
    // Dracula is a dark-kind palette. Assigned to the LIGHT slot while the mode
    // on screen is light, it still forces its own dark variant, so the flip has
    // to drive next-themes to `dark` immediately (Tailwind `dark:` variants would
    // otherwise render dark-on-light until the config round-trip). The
    // Latte-into-light case above only exercises a same-variant assignment.
    const user = userEvent.setup();
    const { binding } = makeBinding();
    renderThemePluginWithTheme(binding);

    expect(screen.getByTestId('theme-probe').textContent).toBe('system');

    await user.click(screen.getByLabelText('Use Dracula as the light theme'));

    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('dark');
    });
  });

  test('assigning a palette to the OTHER mode leaves the current appearance alone', async () => {
    // The whole point of the pair: staging a dark palette while working in
    // light must not drag the app into dark mode.
    const user = userEvent.setup();
    const { binding } = makeBinding();
    renderThemePluginWithTheme(binding);

    await user.click(screen.getByLabelText('Use Catppuccin Frappé as the dark theme'));

    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('system');
    });
  });

  test('reset clears BOTH slots, not just the path the row is keyed by', async () => {
    // The row is anchored to colorThemeLight but speaks for both modes, so a
    // per-path reset would strand the dark palette under a "reset to default"
    // label.
    const user = userEvent.setup();
    const { binding, patches } = makeBinding(
      ConfigSchema.parse({ appearance: { colorThemeLight: 'dracula' } }),
    );
    renderThemePluginWithTheme(binding);

    const resetButton = await screen.findByRole('button', {
      name: /Reset Color theme to default/i,
    });
    await user.click(resetButton);

    await waitFor(() => {
      expect(patches).toEqual([
        { appearance: { colorThemeLight: null, colorThemeDark: null, colorTheme: null } },
      ]);
    });
  });

  test('a rejected write surfaces an inline error instead of failing silently', async () => {
    // Writing through the binding directly skips the form commit that every
    // other field uses to route rejections into its own FormMessage.
    const user = userEvent.setup();
    renderThemePluginWithTheme(makeRejectingBinding());

    // Assign the slot that is actually on screen (jsdom reports no dark
    // preference, so the sun is the live one). Assigning the other slot paints
    // nothing, which would make the revert a no-op and the assertion vacuous.
    expect(document.documentElement.hasAttribute('data-color-theme')).toBe(false);

    await user.click(screen.getByLabelText('Use Catppuccin Latte as the light theme'));

    await waitFor(() => {
      expect(screen.getByText('palette write rejected')).toBeDefined();
    });
    // The optimistic paint set the attribute before the write; the rejection
    // has to undo it, or the user is left looking at a palette that was never
    // persisted next to an error saying so.
    expect(document.documentElement.hasAttribute('data-color-theme')).toBe(false);
  });

  test('a rejected cross-variant pick also reverts the forced light/dark mode', async () => {
    // Assigning a dark palette to the light slot forces dark mode optimistically.
    // Reverting only the palette attribute would strand that mode on the
    // previous palette, so the revert has to undo both effects.
    const user = userEvent.setup();
    renderThemePluginWithTheme(makeRejectingBinding());

    expect(screen.getByTestId('theme-probe').textContent).toBe('system');

    await user.click(screen.getByLabelText('Use Dracula as the light theme'));

    await waitFor(() => {
      expect(screen.getByText('palette write rejected')).toBeDefined();
    });
    // Back to the user's own preference, not Dracula's forced dark.
    await waitFor(() => {
      expect(screen.getByTestId('theme-probe').textContent).toBe('system');
    });
    // Both halves of the optimistic apply have to come back, so check the
    // attribute here too rather than leaving it to the same-variant sibling.
    expect(document.documentElement.hasAttribute('data-color-theme')).toBe(false);
  });

  test('one patch writes both slots and retires the pre-pair key', async () => {
    const user = userEvent.setup();
    const { binding, patches } = makeBinding();
    renderThemePluginWithTheme(binding);

    await user.click(screen.getByLabelText('Use Catppuccin Frappé as the dark theme'));

    await waitFor(() => {
      expect(patches).toEqual([
        {
          appearance: {
            colorThemeLight: 'default',
            colorThemeDark: 'catppuccin-frappe',
            colorTheme: null,
          },
        },
      ]);
    });
  });
});
