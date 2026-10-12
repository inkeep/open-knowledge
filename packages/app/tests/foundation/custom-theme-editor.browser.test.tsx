import {
  bindConfigDoc,
  type ConfigBinding,
} from '@inkeep/open-knowledge-core/config/bind-config-doc';
import { type RenderResult, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { CustomThemeEditor } from '@/components/settings/CustomThemeEditor';
import { SavedThemesProvider } from '@/lib/saved-themes-client';
import { stubApiRoutes } from './api-routes.test-helper';
import { renderWithI18n } from './render-with-i18n.test-helper';

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

function inMemoryUserConfig(): ConfigBinding {
  return bindConfigDoc(
    { document: new Y.Doc(), on: (_event, synced) => synced(), off: () => {} },
    'user',
  );
}

async function renderEditor(binding: ConfigBinding): Promise<RenderResult> {
  const view = renderWithI18n(
    <SavedThemesProvider>
      <CustomThemeEditor userBinding={binding} />
    </SavedThemesProvider>,
  );
  await waitFor(() => {
    expect(view.getByTestId('custom-theme-import')).toBeTruthy();
  });
  return view;
}

async function pasteIntoImport(view: RenderResult, text: string): Promise<void> {
  await userEvent.click(view.getByTestId('custom-theme-import'));
  await userEvent.paste(text);
}

describe('CustomThemeEditor under the real Lingui runtime', () => {
  beforeEach(() => {
    stubApiRoutes({
      '/api/saved-themes': () => Response.json({ themes: [], truncated: false }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('importing a valid pasted scheme writes all sixteen slots and its metadata, and announces the import', async () => {
    const binding = inMemoryUserConfig();
    const view = await renderEditor(binding);

    await pasteIntoImport(view, PASTED_SCHEME);

    expect(binding.current().appearance?.customTheme).toEqual({
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
    });
    expect(view.getByRole('status').textContent).toBe('Theme imported.');
  });

  test('an unparseable paste shows a translated inline error and writes nothing', async () => {
    const binding = inMemoryUserConfig();
    const view = await renderEditor(binding);

    await pasteIntoImport(view, 'not a scheme');

    expect(view.queryByTestId('custom-theme-import-error')?.textContent).toBe(
      'That parsed, but it isn’t a base16 theme.',
    );
    expect(binding.current().appearance?.customTheme).toBeUndefined();
  });

  test.each([
    {
      problem: 'an unresolved YAML alias',
      text: '*missing',
      message: 'That doesn’t parse as YAML or JSON.',
    },
    {
      problem: 'malformed YAML on line 1',
      text: '{[unclosed',
      message: 'That doesn’t parse as YAML or JSON — check line 1.',
    },
    {
      problem: 'two missing color slots',
      text: PASTED_SCHEME.replace('  base0E: "#d2a6ff"\n', '').replace('  base0F: "#e6b673"\n', ''),
      message: 'Missing 2 slot(s): base0E, base0F',
    },
    {
      problem: 'two invalid hex colors',
      text: PASTED_SCHEME.replace('#f07178', 'orange').replace('#e6b673', '#12'),
      message: 'Not a hex color: base08, base0F',
    },
  ])(
    'a paste with $problem shows a translated inline error and writes nothing',
    async ({ text, message }) => {
      const binding = inMemoryUserConfig();
      const view = await renderEditor(binding);

      await pasteIntoImport(view, text);

      expect(binding.current().appearance?.customTheme).toBeUndefined();
      expect(view.queryByTestId('custom-theme-import-error')?.textContent).toBe(message);
    },
  );
});
