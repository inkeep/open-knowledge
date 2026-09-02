import { BASE16_SLOT_ROLES, parseBase16Scheme } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { COLOR_THEMES, type ColorTheme, DEFAULT_CUSTOM_SCHEME } from '@/lib/color-themes';
import type { UpdateSavedThemeResult } from '@/lib/saved-themes-client';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

let mergedConfig: {
  appearance?: {
    theme?: 'system' | 'light' | 'dark';
    colorTheme?: string;
    colorThemeLight?: string;
    colorThemeDark?: string;
    customTheme?: Record<string, string>;
  };
} = {};
const patchCalls: unknown[] = [];
let savedThemes: ColorTheme[] = [];
let editingThemeId = 'custom';
let themeIncarnations: Record<string, number> = {};
const applyColorThemeToDom = vi.fn();
const refreshSavedThemes = vi.fn(async () => {});
const selectThemeToEdit = vi.fn();
const updateTheme = vi.fn(
  async (): Promise<UpdateSavedThemeResult> => ({
    ok: true,
    id: 'saved-theme',
    filename: 'theme.yaml',
  }),
);

function translateLingui(
  message: TemplateStringsArray | string | { message?: string },
  ...values: unknown[]
): string {
  if (typeof message === 'object' && 'message' in message) return message.message ?? '';
  return renderLinguiTemplate(message, ...values);
}

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  msg: renderLinguiTemplate,
  useLingui: () => ({ t: translateLingui }),
}));
vi.doMock('next-themes', () => ({ useTheme: () => ({ setTheme: () => {} }) }));
vi.doMock('@/lib/config-context', () => ({
  useConfigContextOptional: () => ({ merged: mergedConfig }),
}));
vi.doMock('@/lib/use-apply-config-color-theme', () => ({
  applyColorThemeToDom,
}));
vi.doMock('@/lib/saved-themes-client', () => ({
  useSavedThemes: () => ({
    themes: savedThemes,
    refresh: refreshSavedThemes,
    updateTheme,
    editingThemeId,
    themeIncarnations,
    selectThemeToEdit,
  }),
}));

const userBinding = { patch: (p: unknown) => patchCalls.push(p) } as never;

const RETIRED_LEGACY_KEYS = {
  background: null,
  surface: null,
  foreground: null,
  primary: null,
  accent: null,
  border: null,
};

const DEFAULT_SCHEME_PATCH = {
  name: DEFAULT_CUSTOM_SCHEME.name,
  author: null,
  variant: DEFAULT_CUSTOM_SCHEME.variant,
  ...DEFAULT_CUSTOM_SCHEME.palette,
  ...RETIRED_LEGACY_KEYS,
};

const PASTED_SCHEME = `system: "base16"
name: "Ayu Dark"
author: "A. Scheme Author"
variant: "dark"
palette:
  base00: "#0f1419"
  base01: "#131721"
  base02: "#272d38"
  base03: "#3e4b59"
  base04: "#bfbdb6"
  base05: "#e6e1cf"
  base06: "#e6e1cf"
  base07: "#f3f4f5"
  base08: "#f07178"
  base09: "#ff8f40"
  base0A: "#ffb454"
  base0B: "#b8cc52"
  base0C: "#95e6cb"
  base0D: "#59c2ff"
  base0E: "#d2a6ff"
  base0F: "#e6b673"
`;

function pasteTheme(target: HTMLElement, value: string) {
  fireEvent.paste(target, {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? value : '') },
  });
}

async function renderEditor() {
  const { CustomThemeEditor } = await import('./CustomThemeEditor');
  const view = render(<CustomThemeEditor userBinding={userBinding} />);
  return {
    ...view,
    rerenderEditor: () => view.rerender(<CustomThemeEditor userBinding={userBinding} />),
  };
}

function hexInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[aria-label$="hex value"]')];
}

describe('CustomThemeEditor', () => {
  afterEach(() => {
    cleanup();
    patchCalls.length = 0;
    mergedConfig = {};
    savedThemes = [];
    editingThemeId = 'custom';
    themeIncarnations = {};
    applyColorThemeToDom.mockClear();
    refreshSavedThemes.mockClear();
    selectThemeToEdit.mockClear();
    updateTheme.mockReset();
    updateTheme.mockResolvedValue({
      ok: true,
      id: 'saved-theme',
      filename: 'theme.yaml',
    });
  });

  test('renders sixteen selectable swatches with one focused color editor', async () => {
    const { container } = await renderEditor();
    expect(container.querySelectorAll('button[aria-label^="Select base"]').length).toBe(16);
    expect(container.querySelectorAll('input[type="color"]').length).toBe(1);
    expect(hexInputs(container).length).toBe(1);
  });

  test('the section is a landmark labelled by its heading, like sibling subsections', async () => {
    const { container } = await renderEditor();
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-labelledby')).toBe('settings-custom-theme-title');
    const heading = container.querySelector('h3#settings-custom-theme-title');
    expect(heading?.textContent).toBe('Custom theme');
  });

  test('committing a valid hex patches that slot on the user binding', async () => {
    mergedConfig = { appearance: { colorTheme: 'custom' } };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex, { target: { value: '#123456' } });
    expect(patchCalls).toContainEqual({ appearance: { customTheme: { base00: '#123456' } } });
  });

  test('previews edits immediately when the saved theme is assigned to the active slot', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      ...COLOR_THEMES,
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-active',
        colorThemeDark: 'default',
      },
    };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(hex, { target: { value: '#224466' } });

    expect(applyColorThemeToDom).toHaveBeenCalledTimes(1);
    expect(applyColorThemeToDom).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { light: 'saved-active', dark: 'default' },
        slotMode: 'light',
      }),
    );
  });

  test('keeps the committed custom slot cache while previewing a saved theme', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      ...COLOR_THEMES,
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    const customSeed = {
      name: 'Legacy custom',
      variant: 'light',
      ...DEFAULT_CUSTOM_SCHEME.palette,
      base00: '#abcdef',
    };
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-active',
        colorThemeDark: 'custom',
        customTheme: customSeed,
      },
    };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(hex, { target: { value: '#224466' } });

    expect(applyColorThemeToDom).toHaveBeenCalledWith(
      expect.objectContaining({
        customSeed,
        selection: { light: 'saved-active', dark: 'custom' },
        themes: expect.arrayContaining([
          expect.objectContaining({
            id: 'saved-active',
            scheme: expect.objectContaining({
              palette: expect.objectContaining({ base00: '#224466' }),
            }),
          }),
        ]),
      }),
    );
  });

  test('an invalid hex does not patch', async () => {
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: 'nope' } });
    fireEvent.blur(hex, { target: { value: 'nope' } });
    expect(patchCalls.length).toBe(0);
  });

  test('an invalid hex shows an inline error, marks the field invalid, and keeps the value', async () => {
    const { container, queryByTestId } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    expect(queryByTestId('custom-theme-hex-error-base00')).toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(hex, { target: { value: '#12' } });
    expect(queryByTestId('custom-theme-hex-error-base00')).not.toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    expect(hex.value).toBe('#12');
  });

  test('an invalid slot associates its error with the input via aria-describedby', async () => {
    const { container, getByTestId } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    expect(hex.getAttribute('aria-describedby')).toBeNull();

    fireEvent.change(hex, { target: { value: '#12' } });
    const errorId = hex.getAttribute('aria-describedby');
    expect(errorId).toBe('custom-theme-hex-error-base00');
    expect(getByTestId('custom-theme-hex-error-base00').id).toBe(errorId);
  });

  test('reset writes the full default scheme', async () => {
    const { getByText } = await renderEditor();
    fireEvent.click(getByText('Reset'));
    expect(patchCalls).toContainEqual({
      appearance: { customTheme: DEFAULT_SCHEME_PATCH },
    });
  });

  test('importing a pasted scheme writes all sixteen slots and the metadata', async () => {
    const { getByTestId, queryByRole } = await renderEditor();
    pasteTheme(getByTestId('custom-theme-import'), PASTED_SCHEME);
    expect(queryByRole('button', { name: 'Import theme' })).toBeNull();
    expect(patchCalls).toContainEqual({
      appearance: {
        customTheme: {
          name: 'Ayu Dark',
          author: 'A. Scheme Author',
          variant: 'dark',
          base00: '#0f1419',
          base01: '#131721',
          base02: '#272d38',
          base03: '#3e4b59',
          base04: '#bfbdb6',
          base05: '#e6e1cf',
          base06: '#e6e1cf',
          base07: '#f3f4f5',
          base08: '#f07178',
          base09: '#ff8f40',
          base0A: '#ffb454',
          base0B: '#b8cc52',
          base0C: '#95e6cb',
          base0D: '#59c2ff',
          base0E: '#d2a6ff',
          base0F: '#e6b673',
          ...RETIRED_LEGACY_KEYS,
        },
      },
    });
  });

  test('an imported scheme repopulates the slot inputs', async () => {
    const { container, getByTestId } = await renderEditor();
    pasteTheme(getByTestId('custom-theme-import'), PASTED_SCHEME);
    expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#0f1419');
    const base0D = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base0D "]',
    );
    expect(base0D).not.toBeNull();
    fireEvent.click(base0D as HTMLButtonElement);
    expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#59c2ff');
  });

  test('copies the selected swatch value', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const { container, getByRole } = await renderEditor();
    const base0D = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base0D "]',
    );
    fireEvent.click(base0D as HTMLButtonElement);
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(written).toEqual([DEFAULT_CUSTOM_SCHEME.palette.base0D]));
  });

  test('an unparseable paste surfaces an inline error and writes nothing', async () => {
    const { getByTestId, queryByTestId } = await renderEditor();
    pasteTheme(getByTestId('custom-theme-import'), 'not a scheme');
    expect(queryByTestId('custom-theme-import-error')).not.toBeNull();
    expect(patchCalls.length).toBe(0);
  });

  test('editing a slot on a pre-base16 config migrates it and retires the old keys', async () => {
    mergedConfig = {
      appearance: {
        colorTheme: 'custom',
        customTheme: {
          background: '#101010',
          surface: '#202020',
          foreground: '#fafafa',
          primary: '#3366ff',
          accent: '#33ddcc',
          border: '#303030',
        },
      },
    };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex, { target: { value: '#123456' } });

    expect(patchCalls.length).toBe(1);
    const written = (patchCalls[0] as { appearance: { customTheme: Record<string, unknown> } })
      .appearance.customTheme;
    expect(written.base00).toBe('#123456');
    expect(written.base01).toBe('#202020');
    expect(written.base05).toBe('#fafafa');
    expect(written.base0D).toBe('#3366ff');
    for (const key of ['background', 'surface', 'foreground', 'primary', 'accent', 'border']) {
      expect(written[key], key).toBeNull();
    }
  });

  test('editing a slot on an already-base16 config patches only that slot', async () => {
    mergedConfig = {
      appearance: { colorTheme: 'custom', customTheme: { base00: '#101010' } },
    };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex, { target: { value: '#123456' } });
    expect(patchCalls).toContainEqual({ appearance: { customTheme: { base00: '#123456' } } });
  });

  test('every swatch exposes its role, not just the opaque slot id', async () => {
    const { container } = await renderEditor();
    const orange = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base09 "]',
    );
    const blue = container.querySelector<HTMLButtonElement>('button[aria-label^="Select base0D "]');
    expect(orange?.getAttribute('aria-label')).toContain(BASE16_SLOT_ROLES.base09);
    expect(blue?.getAttribute('aria-label')).toContain(BASE16_SLOT_ROLES.base0D);
  });

  test('the preview renders and marks the surfaces a hovered slot drives', async () => {
    const { container, getByLabelText } = await renderEditor();
    const preview = getByLabelText('Theme preview');
    expect(preview).toBeTruthy();
    expect(container.querySelectorAll('[data-lit="true"]').length).toBe(0);

    const stringSwatch = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base0B "]',
    );
    expect(stringSwatch).not.toBeNull();
    fireEvent.mouseEnter(stringSwatch as HTMLButtonElement);
    expect(
      container.querySelectorAll('[data-lit="true"][data-slot="base0B"]').length,
    ).toBeGreaterThan(0);

    fireEvent.mouseLeave(stringSwatch as HTMLButtonElement);
    expect(container.querySelectorAll('[data-lit="true"]').length).toBe(0);
  });

  test('keyboard focus lights the same surfaces as hover', async () => {
    const { container } = await renderEditor();
    const swatch = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base0E "]',
    );
    expect(swatch).not.toBeNull();
    fireEvent.focus(swatch as HTMLButtonElement);
    expect(
      container.querySelectorAll('[data-lit="true"][data-slot="base0E"]').length,
    ).toBeGreaterThan(0);
    fireEvent.blur(swatch as HTMLButtonElement);
    expect(container.querySelectorAll('[data-lit="true"]').length).toBe(0);
  });

  test('copy-as-YAML writes a scheme that parses back', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const { getByText } = await renderEditor();
    fireEvent.click(getByText('Copy as YAML'));
    await Promise.resolve();
    expect(written.length).toBe(1);
    const parsed = parseBase16Scheme(written[0] as string);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scheme.palette).toEqual(DEFAULT_CUSTOM_SCHEME.palette);
  });

  test('links out to the upstream scheme collection', async () => {
    const { container } = await renderEditor();
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/tinted-theming/schemes"]',
    );
    expect(link).not.toBeNull();
    expect(link?.rel).toContain('noopener');
  });

  test('the import error clears once the user edits the paste again', async () => {
    const { getByTestId, queryByTestId } = await renderEditor();
    const textarea = getByTestId('custom-theme-import');
    pasteTheme(textarea, 'not a scheme');
    expect(queryByTestId('custom-theme-import-error')).not.toBeNull();
    fireEvent.change(textarea, { target: { value: 'base00: "#111111"' } });
    expect(queryByTestId('custom-theme-import-error')).toBeNull();
  });

  test('does not refresh or announce saved until the newest autosave revision settles', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    const resolvers: Array<(result: UpdateSavedThemeResult) => void> = [];
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { container, getByText, queryByText } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    const base01 = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Select base01 "]',
    );
    fireEvent.click(base01 as HTMLButtonElement);
    const second = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(second, { target: { value: '#223344' } });
    fireEvent.blur(second, { target: { value: '#223344' } });

    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(2));
    expect(getByText('Saving changes…')).toBeDefined();

    await act(async () => {
      resolvers[0]?.({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    });
    expect(refreshSavedThemes).not.toHaveBeenCalled();
    expect(queryByText('Changes saved automatically.')).toBeNull();
    expect(getByText('Saving changes…')).toBeDefined();

    await act(async () => {
      resolvers[1]?.({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    });
    await waitFor(() => expect(refreshSavedThemes).toHaveBeenCalledTimes(1));
    expect(getByText('Changes saved automatically.')).toBeDefined();
  });

  test('shows a problem status when autosaving a saved theme fails', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    updateTheme.mockResolvedValueOnce({ ok: false, reason: 'unexpected' });
    const { container, getByText } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });

    await waitFor(() =>
      expect(getByText('Couldn’t save changes. Try editing a color again.')).toBeDefined(),
    );
    expect(refreshSavedThemes).not.toHaveBeenCalled();
  });

  test('does not roll back a newer palette selection when an older autosave fails', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      ...COLOR_THEMES,
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-active',
        colorThemeDark: 'default',
      },
    };
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { container, rerenderEditor, getByText } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(1));
    applyColorThemeToDom.mockClear();

    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'default',
        colorThemeDark: 'default',
      },
    };
    rerenderEditor();
    await act(async () => {
      resolveUpdate?.({ ok: false, reason: 'unexpected' });
    });

    expect(getByText('Couldn’t save changes. Try editing a color again.')).toBeDefined();
    expect(applyColorThemeToDom).not.toHaveBeenCalled();
  });

  test('rolls a failed preview back to the latest committed registry state', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      ...COLOR_THEMES,
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-active',
        colorThemeDark: 'custom',
      },
    };
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { container, rerenderEditor } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(1));
    applyColorThemeToDom.mockClear();

    const latestCommitted = {
      ...DEFAULT_CUSTOM_SCHEME,
      palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#abcdef' },
    };
    savedThemes = [
      ...COLOR_THEMES,
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: latestCommitted,
      },
    ];
    rerenderEditor();
    await act(async () => {
      resolveUpdate?.({ ok: false, reason: 'unexpected' });
    });

    expect(applyColorThemeToDom).toHaveBeenCalledWith(
      expect.objectContaining({
        themes: expect.arrayContaining([
          expect.objectContaining({ id: 'saved-active', scheme: latestCommitted }),
        ]),
      }),
    );
  });

  test('retries after an autosave problem and reports the later save', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    updateTheme
      .mockResolvedValueOnce({ ok: false, reason: 'unexpected' })
      .mockResolvedValueOnce({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    const { container, getByText, queryByText } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() =>
      expect(getByText('Couldn’t save changes. Try editing a color again.')).toBeDefined(),
    );

    fireEvent.change(first, { target: { value: '#445566' } });
    fireEvent.blur(first, { target: { value: '#445566' } });

    await waitFor(() => expect(getByText('Changes saved automatically.')).toBeDefined());
    expect(queryByText('Couldn’t save changes. Try editing a color again.')).toBeNull();
    expect(refreshSavedThemes).toHaveBeenCalledTimes(1);
  });

  test('keeps a newer local draft when an intermediate registry refresh arrives', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { container, rerenderEditor } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(1));

    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: {
          ...DEFAULT_CUSTOM_SCHEME,
          palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#abcdef' },
        },
      },
    ];
    rerenderEditor();

    expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#112233');

    await act(async () => {
      resolveUpdate?.({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    });
  });

  test('keeps a newer uncommitted draft when an older autosave finishes', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme
      .mockImplementationOnce(
        async () =>
          new Promise<UpdateSavedThemeResult>((resolve) => {
            resolveUpdate = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    const { container } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(1));

    fireEvent.change(first, { target: { value: '#445566' } });

    await act(async () => {
      resolveUpdate?.({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    });
    expect(first.value).toBe('#445566');

    fireEvent.blur(first, { target: { value: '#445566' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(2));
    expect(updateTheme).toHaveBeenLastCalledWith({
      id: 'saved-active',
      scheme: {
        ...DEFAULT_CUSTOM_SCHEME,
        palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#445566' },
      },
    });
  });

  test('keeps pending drafts isolated when switching between saved themes', async () => {
    const themeA = {
      ...DEFAULT_CUSTOM_SCHEME,
      name: 'Theme A',
      palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#aaaaaa' },
    };
    const themeB = {
      ...DEFAULT_CUSTOM_SCHEME,
      name: 'Theme B',
      palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#bbbbbb' },
    };
    editingThemeId = 'saved-a';
    savedThemes = [
      { id: 'saved-a', label: 'Theme A', kind: 'dark', scheme: themeA },
      { id: 'saved-b', label: 'Theme B', kind: 'dark', scheme: themeB },
    ];
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { container, rerenderEditor } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(updateTheme).toHaveBeenCalledTimes(1));

    editingThemeId = 'saved-b';
    rerenderEditor();
    await waitFor(() =>
      expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#bbbbbb'),
    );

    editingThemeId = 'saved-a';
    rerenderEditor();
    await waitFor(() =>
      expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#112233'),
    );

    await act(async () => {
      resolveUpdate?.({ ok: true, id: 'saved-a', filename: 'a.yaml' });
    });
  });

  test('drops draft and autosave state when a deleted id is recreated', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Old',
        kind: 'dark',
        scheme: DEFAULT_CUSTOM_SCHEME,
      },
    ];
    let resolveUpdate: ((result: UpdateSavedThemeResult) => void) | undefined;
    updateTheme.mockImplementation(
      async () =>
        new Promise<UpdateSavedThemeResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { container, rerenderEditor, getByText, queryByText } = await renderEditor();
    const first = hexInputs(container)[0] as HTMLInputElement;

    fireEvent.change(first, { target: { value: '#112233' } });
    fireEvent.blur(first, { target: { value: '#112233' } });
    await waitFor(() => expect(getByText('Saving changes…')).toBeDefined());

    themeIncarnations = { 'saved-active': 1 };
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Recreated',
        kind: 'light',
        scheme: {
          ...DEFAULT_CUSTOM_SCHEME,
          name: 'Recreated',
          variant: 'light',
          palette: { ...DEFAULT_CUSTOM_SCHEME.palette, base00: '#abcdef' },
        },
      },
    ];
    rerenderEditor();

    await waitFor(() =>
      expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#abcdef'),
    );
    expect(queryByText('Saving changes…')).toBeNull();

    await act(async () => {
      resolveUpdate?.({ ok: true, id: 'saved-active', filename: 'active.yaml' });
    });

    expect(refreshSavedThemes).not.toHaveBeenCalled();
    expect((hexInputs(container)[0] as HTMLInputElement).value).toBe('#abcdef');
    expect(queryByText('Changes saved automatically.')).toBeNull();
  });

  test('Done closes a saved theme editor', async () => {
    editingThemeId = 'saved-active';
    savedThemes = [
      {
        id: 'saved-active',
        label: 'Active',
        kind: 'dark',
        scheme: { ...DEFAULT_CUSTOM_SCHEME, name: 'Active' },
      },
    ];
    const user = userEvent.setup();
    const { getByRole } = await renderEditor();

    await user.click(getByRole('button', { name: 'Done' }));

    expect(selectThemeToEdit).toHaveBeenCalledWith(null);
  });
});
