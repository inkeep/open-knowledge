import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CUSTOM_SEED } from '@/lib/color-themes';
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

async function renderEditor() {
  const { CustomThemeEditor } = await import('./CustomThemeEditor');
  return render(<CustomThemeEditor userBinding={userBinding} />);
}

describe('CustomThemeEditor', () => {
  afterEach(() => {
    cleanup();
    patchCalls.length = 0;
    mergedConfig = {};
  });

  test('renders a color + hex input for each of the six seed fields', async () => {
    const { container } = await renderEditor();
    expect(container.querySelectorAll('input[type="color"]').length).toBe(6);
    // 6 color + 6 hex text inputs.
    expect(container.querySelectorAll('input').length).toBe(12);
  });

  test('the section is a landmark labelled by its heading, like sibling subsections', async () => {
    const { container } = await renderEditor();
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-labelledby')).toBe('settings-custom-theme-title');
    const heading = container.querySelector('h3#settings-custom-theme-title');
    expect(heading?.textContent).toBe('Custom theme');
  });

  test('committing a valid hex patches that field on the user binding', async () => {
    mergedConfig = { appearance: { colorTheme: 'custom' } };
    const { container } = await renderEditor();
    const hex = container.querySelectorAll('input:not([type="color"])')[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.blur(hex, { target: { value: '#123456' } });
    expect(patchCalls).toContainEqual({ appearance: { customTheme: { background: '#123456' } } });
  });

  test('an invalid hex does not patch', async () => {
    const { container } = await renderEditor();
    const hex = container.querySelectorAll('input:not([type="color"])')[0] as HTMLInputElement;
    fireEvent.change(hex, { target: { value: 'nope' } });
    fireEvent.blur(hex, { target: { value: 'nope' } });
    expect(patchCalls.length).toBe(0);
  });

  test('an invalid hex shows an inline error, marks the field invalid, and keeps the value', async () => {
    const { container, queryByTestId } = await renderEditor();
    const hex = container.querySelectorAll('input:not([type="color"])')[0] as HTMLInputElement;
    // Pristine value is a valid hex — no error, not marked invalid.
    expect(queryByTestId('custom-theme-hex-error-background')).toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(hex, { target: { value: '#12' } });
    expect(queryByTestId('custom-theme-hex-error-background')).not.toBeNull();
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    // The invalid value stays visible (no silent revert) so the user can fix it.
    expect(hex.value).toBe('#12');
  });

  test('reset writes the full default seed', async () => {
    const { getByText } = await renderEditor();
    fireEvent.click(getByText('Reset'));
    expect(patchCalls).toContainEqual({
      appearance: { customTheme: { ...DEFAULT_CUSTOM_SEED } },
    });
  });
});
