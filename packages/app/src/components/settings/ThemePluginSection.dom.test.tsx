import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type ColorTheme, DEFAULT_CUSTOM_SCHEME } from '@/lib/color-themes';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

let themes: ColorTheme[] = [];
let editingThemeId = 'custom';
let themeEditorOpen = false;
const selectThemeToEdit = vi.fn();

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  msg: renderLinguiTemplate,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));
vi.doMock('@/lib/saved-themes-client', () => ({
  useSavedThemes: () => ({ themes, editingThemeId, themeEditorOpen, selectThemeToEdit }),
}));
vi.doMock('./CustomThemeEditor', () => ({
  CustomThemeEditor: () => <div data-testid="theme-editor" />,
}));
vi.doMock('./schema-section', () => ({
  BoundSchemaSection: () => <div data-testid="theme-picker" />,
}));

describe('ThemePluginSection', () => {
  afterEach(() => {
    cleanup();
    themes = [];
    editingThemeId = 'custom';
    themeEditorOpen = false;
    selectThemeToEdit.mockClear();
  });

  test('closes the editor instead of falling back to custom when its saved theme disappears', async () => {
    const savedTheme = {
      id: 'saved-active',
      label: 'Active',
      kind: 'dark' as const,
      scheme: { ...DEFAULT_CUSTOM_SCHEME, name: 'Active' },
    };
    themes = [savedTheme];
    editingThemeId = savedTheme.id;
    themeEditorOpen = true;
    const { ThemePluginSection } = await import('./ThemePluginSection');
    const view = render(<ThemePluginSection userBinding={{} as never} />);
    expect(screen.getByTestId('theme-editor')).toBeDefined();

    themes = [];
    view.rerender(<ThemePluginSection userBinding={{} as never} />);

    expect(screen.queryByTestId('theme-editor')).toBeNull();
    await waitFor(() => expect(selectThemeToEdit).toHaveBeenCalledWith(null));
  });
});
