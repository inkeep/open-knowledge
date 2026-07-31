import { BASE16_SLOT_ROLES, BASE16_SLOTS, parseBase16Scheme } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CUSTOM_SCHEME } from '@/lib/color-themes';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

let mergedConfig: { appearance?: { colorTheme?: string; customTheme?: Record<string, string> } } =
  {};
const patchCalls: unknown[] = [];

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));
vi.doMock('next-themes', () => ({ useTheme: () => ({ setTheme: () => {} }) }));
vi.doMock('@/lib/config-context', () => ({
  useConfigContextOptional: () => ({ merged: mergedConfig }),
}));
vi.doMock('@/lib/use-apply-config-color-theme', () => ({
  applyColorThemeToDom: () => {},
}));

const userBinding = { patch: (p: unknown) => patchCalls.push(p) } as never;

/** The six pre-base16 seed keys, nulled by every full-scheme write to delete them. */
const RETIRED_LEGACY_KEYS = {
  background: null,
  surface: null,
  foreground: null,
  primary: null,
  accent: null,
  border: null,
};

/** The full scheme flattened into the config shape `reset` / `import` write. */
const DEFAULT_SCHEME_PATCH = {
  name: DEFAULT_CUSTOM_SCHEME.name,
  // The default scheme carries no credit, and the write nulls it so importing a
  // credited scheme and then resetting doesn't strand the old author.
  author: null,
  variant: DEFAULT_CUSTOM_SCHEME.variant,
  ...DEFAULT_CUSTOM_SCHEME.palette,
  ...RETIRED_LEGACY_KEYS,
};

/** A complete scheme in the current upstream layout, for the import path. */
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

async function renderEditor() {
  const { CustomThemeEditor } = await import('./CustomThemeEditor');
  return render(<CustomThemeEditor userBinding={userBinding} />);
}

function hexInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input:not([type="color"])')];
}

describe('CustomThemeEditor', () => {
  afterEach(() => {
    cleanup();
    patchCalls.length = 0;
    mergedConfig = {};
  });

  test('renders a color + hex input for each of the sixteen base16 slots', async () => {
    const { container } = await renderEditor();
    expect(container.querySelectorAll('input[type="color"]').length).toBe(16);
    // 16 color + 16 hex text inputs.
    expect(hexInputs(container).length).toBe(16);
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
    // Pristine value is a valid hex — no error, not marked invalid.
    expect(queryByTestId('custom-theme-hex-error-base00')).toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(hex, { target: { value: '#12' } });
    expect(queryByTestId('custom-theme-hex-error-base00')).not.toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    // The invalid value stays visible (no silent revert) so the user can fix it.
    expect(hex.value).toBe('#12');
  });

  test('an invalid slot associates its error with the input via aria-describedby', async () => {
    // A screen-reader user returning to an invalid hex field must hear the error
    // as the field's description, not just once when it first appears. The
    // describedby target must exist and carry the message (mirrors the
    // paste-import field's own wiring).
    const { container, getByTestId } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    // Valid pristine value: no association.
    expect(hex.getAttribute('aria-describedby')).toBeNull();

    fireEvent.change(hex, { target: { value: '#12' } });
    const errorId = hex.getAttribute('aria-describedby');
    expect(errorId).toBe('custom-theme-hex-error-base00');
    // The referenced node exists and carries the error text.
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
    // `author` included: a scheme's credit line has to survive the write, or it
    // is gone by the next reload and "Copy as YAML" hands back an uncredited
    // copy of someone else's scheme.
    const { getByTestId, getByText } = await renderEditor();
    fireEvent.change(getByTestId('custom-theme-import'), { target: { value: PASTED_SCHEME } });
    fireEvent.click(getByText('Import scheme'));
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
    const { container, getByTestId, getByText } = await renderEditor();
    fireEvent.change(getByTestId('custom-theme-import'), { target: { value: PASTED_SCHEME } });
    fireEvent.click(getByText('Import scheme'));
    const values = hexInputs(container).map((input) => input.value);
    expect(values[0]).toBe('#0f1419');
    expect(values[BASE16_SLOTS.indexOf('base0D')]).toBe('#59c2ff');
  });

  test('an unparseable paste surfaces an inline error and writes nothing', async () => {
    const { getByTestId, getByText, queryByTestId } = await renderEditor();
    fireEvent.change(getByTestId('custom-theme-import'), { target: { value: 'not a scheme' } });
    fireEvent.click(getByText('Import scheme'));
    expect(queryByTestId('custom-theme-import-error')).not.toBeNull();
    expect(patchCalls.length).toBe(0);
  });

  test('editing a slot on a pre-base16 config migrates it and retires the old keys', async () => {
    // The upgrade path: a user with an existing custom theme changes one color.
    // The write must carry their whole (upgraded) palette and delete the six
    // legacy keys, not leave a half-format config behind.
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
    // The edited slot, and the rest of their palette carried through.
    expect(written.base00).toBe('#123456');
    expect(written.base01).toBe('#202020');
    expect(written.base05).toBe('#fafafa');
    expect(written.base0D).toBe('#3366ff');
    // Legacy keys nulled — a null in a config patch deletes the key.
    for (const key of ['background', 'surface', 'foreground', 'primary', 'accent', 'border']) {
      expect(written[key], key).toBeNull();
    }
  });

  test('editing a slot on an already-base16 config patches only that slot', async () => {
    // No migration to do, so the write stays minimal rather than rewriting all
    // sixteen slots on every keystroke-commit.
    mergedConfig = {
      appearance: { colorTheme: 'custom', customTheme: { base00: '#101010' } },
    };
    const { container } = await renderEditor();
    const hex = hexInputs(container)[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex, { target: { value: '#123456' } });
    expect(patchCalls).toContainEqual({ appearance: { customTheme: { base00: '#123456' } } });
  });

  test('every slot shows its role, not just the opaque slot id', async () => {
    // `base09` teaches nothing on its own; the role is what makes the control
    // legible without cross-referencing the spec.
    const { container } = await renderEditor();
    const text = container.textContent ?? '';
    expect(text).toContain('base09');
    expect(text).toContain(BASE16_SLOT_ROLES.base09);
    expect(text).toContain(BASE16_SLOT_ROLES.base0D);
  });

  test('the preview renders and marks the surfaces a hovered slot drives', async () => {
    const { container, getByLabelText } = await renderEditor();
    const preview = getByLabelText('Theme preview');
    expect(preview).toBeTruthy();
    // Nothing is lit until a slot is pointed at.
    expect(container.querySelectorAll('[data-lit="true"]').length).toBe(0);

    const stringSwatch = container.querySelector<HTMLInputElement>('input[aria-label^="base0B "]');
    expect(stringSwatch).not.toBeNull();
    fireEvent.mouseEnter(stringSwatch as HTMLInputElement);
    // base0B is the strings slot — the code sample's string literal lights up.
    expect(
      container.querySelectorAll('[data-lit="true"][data-slot="base0B"]').length,
    ).toBeGreaterThan(0);

    fireEvent.mouseLeave(stringSwatch as HTMLInputElement);
    expect(container.querySelectorAll('[data-lit="true"]').length).toBe(0);
  });

  test('keyboard focus lights the same surfaces as hover', async () => {
    // The spotlight must not be pointer-only — the slot list is a tab sequence.
    const { container } = await renderEditor();
    const hex = container.querySelector<HTMLInputElement>('input[aria-label="base0E hex value"]');
    expect(hex).not.toBeNull();
    fireEvent.focus(hex as HTMLInputElement);
    expect(
      container.querySelectorAll('[data-lit="true"][data-slot="base0E"]').length,
    ).toBeGreaterThan(0);
    fireEvent.blur(hex as HTMLInputElement);
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
    const { getByTestId, getByText, queryByTestId } = await renderEditor();
    const textarea = getByTestId('custom-theme-import');
    fireEvent.change(textarea, { target: { value: 'not a scheme' } });
    fireEvent.click(getByText('Import scheme'));
    expect(queryByTestId('custom-theme-import-error')).not.toBeNull();
    fireEvent.change(textarea, { target: { value: 'base00: "#111111"' } });
    expect(queryByTestId('custom-theme-import-error')).toBeNull();
  });
});
