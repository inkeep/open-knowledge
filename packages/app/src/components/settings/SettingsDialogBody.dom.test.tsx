import { afterEach, describe, expect, test } from 'bun:test';
import {
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  type ConfigPatch,
  ConfigSchema,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { emitConfigValidationRejected } from '@/lib/config-validation-events';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { SettingsDialogBody } from './SettingsDialogBody';

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
        effective: ConfigSchema.parse({ ...config, ...patch }),
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

function makeConfigContextValue(projectBinding: ConfigBinding = makeBinding().binding) {
  const config = ConfigSchema.parse({});
  return {
    userBinding: null,
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

function SettingsContextProvider({ children }: { children: ReactNode }) {
  return <ConfigContext value={makeConfigContextValue()}>{children}</ConfigContext>;
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

function themeToggleItem(container: HTMLElement, option: string): HTMLElement {
  const field = container.querySelector('[data-field="appearance.theme"]');
  if (!field) throw new Error('appearance.theme field not rendered');
  return within(field as HTMLElement).getByText(option);
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
