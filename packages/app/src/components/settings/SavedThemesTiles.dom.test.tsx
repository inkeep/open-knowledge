import {
  BASE16_SLOTS,
  ProblemDetailsSchema,
  SavedThemeDeleteSuccessSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemesListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import * as actualSonner from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLOR_THEMES, type ColorThemeSelectionInput } from '@/lib/color-themes';
import { SavedThemesProvider } from '@/lib/saved-themes-client';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const toastMessage = vi.fn((_message: string, _options?: unknown) => 'theme-delete');
const toastError = vi.fn((_message: string) => 'theme-delete-error');
const toastSuccess = vi.fn((_message: string) => 'theme-restore');
const toastDismiss = vi.fn((_id?: string | number) => {});
vi.doMock('sonner', () => ({
  ...actualSonner,
  toast: Object.assign(toastMessage, {
    error: toastError,
    success: toastSuccess,
    dismiss: toastDismiss,
  }),
}));

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  toastMessage.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  toastDismiss.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function palette(): Record<string, string> {
  return Object.fromEntries(
    BASE16_SLOTS.map((slot, i) => {
      const byte = (i * 16).toString(16).padStart(2, '0');
      return [slot, `#${byte}${byte}${byte}`];
    }),
  );
}

function listBody(themes: unknown[], truncated = false): unknown {
  return SavedThemesListSuccessSchema.parse({ themes, truncated });
}

function stubFetch(body: unknown): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const DEFAULTS: ColorThemeSelectionInput = {
  colorThemeLight: 'default',
  colorThemeDark: 'default',
};

async function renderTiles() {
  const { SavedThemesTiles } = await import('./SavedThemesTiles');
  return render(
    <SavedThemesProvider>
      <SavedThemesTiles appearance={DEFAULTS} onAssign={() => {}} aria-label="Color theme" />
    </SavedThemesProvider>,
  );
}

describe('SavedThemesTiles', () => {
  test('shows a saved palette alongside the built-ins', async () => {
    stubFetch(
      listBody([
        {
          ok: true,
          id: 'saved-ocean',
          filename: 'ocean.yaml',
          scheme: { name: 'Ocean', variant: 'dark', palette: palette() },
        },
      ]),
    );

    await renderTiles();

    expect(await screen.findByText('Ocean')).toBeDefined();
    expect(screen.getByText('Dracula')).toBeDefined();
    expect(screen.getAllByRole('group')).toHaveLength(COLOR_THEMES.length + 1);
  });

  test('assigns a saved palette to light and dark with the same tile controls as a built-in', async () => {
    stubFetch(
      listBody([
        {
          ok: true,
          id: 'saved-ocean',
          filename: 'ocean.yaml',
          scheme: { name: 'Ocean', variant: 'dark', palette: palette() },
        },
      ]),
    );
    const { SavedThemesTiles } = await import('./SavedThemesTiles');
    function Harness() {
      const [appearance, setAppearance] = useState(DEFAULTS);
      return (
        <SavedThemesTiles
          appearance={appearance}
          onAssign={(slot, id) =>
            setAppearance((current) => ({
              ...current,
              [slot === 'light' ? 'colorThemeLight' : 'colorThemeDark']: id,
            }))
          }
          aria-label="Color theme"
        />
      );
    }

    render(
      <SavedThemesProvider>
        <Harness />
      </SavedThemesProvider>,
    );
    const tile = await screen.findByRole('group', { name: 'Ocean' });
    const light = within(tile).getByRole('button', { name: 'Use Ocean as the light theme' });
    const dark = within(tile).getByRole('button', { name: 'Use Ocean as the dark theme' });

    fireEvent.click(light);
    expect(light.getAttribute('data-state')).toBe('on');
    fireEvent.click(dark);
    expect(light.getAttribute('data-state')).toBe('on');
    expect(dark.getAttribute('data-state')).toBe('on');
  });

  test('keeps a malformed saved file visible as an unusable tile with its reason', async () => {
    stubFetch(
      listBody([{ ok: false, filename: 'broken.yaml', id: 'saved-broken', code: 'missing-slots' }]),
    );

    await renderTiles();

    const tile = await screen.findByRole('group', { name: 'broken.yaml' });
    expect(within(tile).getByText('Missing palette colors')).toBeDefined();
    expect(
      within(tile).getByText('This theme can’t be used until the file is fixed.'),
    ).toBeDefined();
    expect(within(tile).queryByRole('button')).toBeNull();
  });

  test('localizes bounded-read warning codes instead of exposing machine values', async () => {
    stubFetch(
      listBody([
        {
          ok: false,
          filename: 'enormous.yaml',
          id: 'saved-enormous',
          code: 'file-too-large',
        },
      ]),
    );

    await renderTiles();

    const tile = await screen.findByRole('group', { name: 'enormous.yaml' });
    expect(within(tile).getByText('This theme file is too large')).toBeDefined();
    expect(tile.textContent).not.toContain('file-too-large');
  });

  test('scans again when the settings surface closes and reopens', async () => {
    stubFetch(listBody([]));
    const first = await renderTiles();
    expect(await screen.findByText('Dracula')).toBeDefined();
    expect(screen.queryByText('New file')).toBeNull();
    first.unmount();

    stubFetch(
      listBody([
        {
          ok: true,
          id: 'saved-new-file',
          filename: 'new-file.yaml',
          scheme: { name: 'New file', variant: 'light', palette: palette() },
        },
      ]),
    );
    await renderTiles();

    expect(await screen.findByText('New file')).toBeDefined();
  });

  test('an empty store shows the built-ins exactly as today, with no empty-state artifact', async () => {
    stubFetch(listBody([]));

    await renderTiles();

    expect(await screen.findByText('Dracula')).toBeDefined();
    expect(screen.getAllByRole('group')).toHaveLength(COLOR_THEMES.length);
    expect(screen.getByRole('button', { name: 'Create new theme' })).toBeDefined();
  });

  test('warns when the saved-theme scan returns an incomplete list', async () => {
    let resolveScan: ((response: Response) => void) | undefined;
    globalThis.fetch = async () =>
      new Promise<Response>((resolve) => {
        resolveScan = resolve;
      });

    await renderTiles();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');

    await waitFor(() => expect(resolveScan).toBeDefined());
    await act(async () => {
      resolveScan?.(Response.json(listBody([], true)));
    });

    await waitFor(() =>
      expect(status.textContent).toBe(
        'Some saved themes aren’t shown because the theme folder exceeds the scan limit.',
      ),
    );
  });

  test('shows a localized bounded retry when the authoritative list fails', async () => {
    let available = false;
    globalThis.fetch = async () =>
      available
        ? Response.json(
            listBody([
              {
                ok: true,
                id: 'saved-ocean',
                filename: 'ocean.yaml',
                scheme: { name: 'Ocean', variant: 'dark', palette: palette() },
              },
            ]),
          )
        : Response.json({ error: 'offline' }, { status: 503 });

    await renderTiles();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Saved themes couldn’t load.');
    expect(screen.getByText('Dracula')).toBeDefined();

    available = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('group', { name: 'Ocean' })).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('deletes an assigned saved theme without confirmation and restores its palette from undo', async () => {
    const oceanScheme = { name: 'Ocean', variant: 'dark' as const, palette: palette() };
    const deletedScheme = {
      ...oceanScheme,
      author: 'Exact disk author',
      palette: { ...oceanScheme.palette, base00: '#123456' },
    };
    let exists = true;
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      requests.push({ path, init });
      if (init?.method === 'DELETE') {
        exists = false;
        return Response.json(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'ocean.yml',
            scheme: deletedScheme,
          }),
        );
      }
      if (init?.method === 'POST') {
        exists = true;
        return Response.json(
          SavedThemeSaveSuccessSchema.parse({ id: 'saved-ocean', filename: 'ocean.yml' }),
          { status: 201 },
        );
      }
      return Response.json(
        listBody(
          exists
            ? [
                {
                  ok: true,
                  id: 'saved-ocean',
                  filename: 'ocean.yml',
                  scheme: oceanScheme,
                },
              ]
            : [],
        ),
      );
    };
    const confirm = vi.spyOn(window, 'confirm');
    const assigned: ColorThemeSelectionInput = {
      colorThemeLight: 'saved-ocean',
      colorThemeDark: 'saved-ocean',
    };
    const { SavedThemesTiles } = await import('./SavedThemesTiles');
    render(
      <SavedThemesProvider>
        <SavedThemesTiles appearance={assigned} onAssign={() => {}} aria-label="Color theme" />
      </SavedThemesProvider>,
    );

    const tile = await screen.findByRole('group', { name: 'Ocean' });
    fireEvent.click(within(tile).getByRole('button', { name: 'Delete Ocean' }));

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Ocean' })).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Use Solarized for the active light mode' }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      requests.some(
        ({ path, init }) => path.endsWith('?id=saved-ocean') && init?.method === 'DELETE',
      ),
    ).toBe(true);
    expect(toastMessage).toHaveBeenCalledTimes(1);
    const options = toastMessage.mock.calls[0]?.[1] as
      | { duration?: number; action?: { label: string; onClick: () => Promise<void> } }
      | undefined;
    expect(options?.duration).toBeGreaterThanOrEqual(10_000);
    expect(options?.action?.label).toBe('Undo');

    fireEvent.click(screen.getByRole('button', { name: 'Use Dracula as the light theme' }));
    expect(toastDismiss).not.toHaveBeenCalled();

    await act(async () => {
      await options?.action?.onClick();
    });

    const restored = await screen.findByRole('group', { name: 'Ocean' });
    expect(restored).toBeDefined();
    const restoreRequest = requests.find(({ init }) => init?.method === 'POST');
    expect(JSON.parse(String(restoreRequest?.init?.body))).toEqual({
      name: 'Ocean',
      stem: 'ocean',
      scheme: deletedScheme,
      extension: '.yml',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Restored Ocean.');
    expect(toastError).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  test('keeps the theme visible and shows an error toast when deletion fails', async () => {
    const oceanScheme = { name: 'Ocean', variant: 'dark' as const, palette: palette() };
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'DELETE') {
        return Response.json({ error: 'offline' }, { status: 503 });
      }
      return Response.json(
        listBody([
          {
            ok: true,
            id: 'saved-ocean',
            filename: 'ocean.yaml',
            scheme: oceanScheme,
          },
        ]),
      );
    };

    await renderTiles();

    const tile = await screen.findByRole('group', { name: 'Ocean' });
    fireEvent.click(within(tile).getByRole('button', { name: 'Delete Ocean' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Couldn’t delete Ocean. Try again.'),
    );
    expect(screen.getByRole('group', { name: 'Ocean' })).toBeDefined();
    expect(toastMessage).not.toHaveBeenCalled();
  });

  test.each([
    {
      failure: 'name conflict',
      status: 409,
      body: ProblemDetailsSchema.parse({
        type: 'urn:ok:error:theme-name-taken',
        title: 'A saved theme with that name already exists.',
        status: 409,
      }),
      message: 'Couldn’t restore Ocean. That name is already in use.',
    },
    {
      failure: 'unexpected server error',
      status: 503,
      body: { error: 'offline' },
      message: 'Couldn’t restore Ocean. Try again.',
    },
  ])('keeps a deleted theme removed when undo restore hits a $failure', async (failure) => {
    const oceanScheme = { name: 'Ocean', variant: 'dark' as const, palette: palette() };
    let exists = true;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'DELETE') {
        exists = false;
        return Response.json(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'ocean.yaml',
            scheme: oceanScheme,
          }),
        );
      }
      if (init?.method === 'POST') {
        return Response.json(failure.body, { status: failure.status });
      }
      return Response.json(
        listBody(
          exists
            ? [
                {
                  ok: true,
                  id: 'saved-ocean',
                  filename: 'ocean.yaml',
                  scheme: oceanScheme,
                },
              ]
            : [],
        ),
      );
    };

    await renderTiles();

    const tile = await screen.findByRole('group', { name: 'Ocean' });
    fireEvent.click(within(tile).getByRole('button', { name: 'Delete Ocean' }));
    await waitFor(() => expect(toastMessage).toHaveBeenCalledTimes(1));
    const options = toastMessage.mock.calls[0]?.[1] as
      | { action?: { onClick: () => Promise<void> } }
      | undefined;

    await act(async () => {
      await options?.action?.onClick();
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(failure.message));
    expect(screen.queryByRole('group', { name: 'Ocean' })).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  test('renders an inline error and focuses the name field when create is submitted empty', async () => {
    const requestMethods: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestMethods.push(init?.method ?? 'GET');
      return Response.json(listBody([]));
    };
    await renderTiles();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create new theme' }));
    const dialog = screen.getByRole('dialog', { name: 'Name your theme' });
    const name = within(dialog).getByLabelText('Theme name');
    await user.click(within(dialog).getByRole('button', { name: 'Create & edit' }));

    expect(within(dialog).getByText('Enter a name for this theme.')).toBeDefined();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    expect(requestMethods).not.toContain('POST');
  });

  test('keeps the create dialog open and renders the name conflict returned by the server', async () => {
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        return Response.json(
          ProblemDetailsSchema.parse({
            type: 'urn:ok:error:theme-name-taken',
            title: 'A saved theme with that name already exists.',
            status: 409,
          }),
          { status: 409 },
        );
      }
      return Response.json(listBody([]));
    };
    await renderTiles();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create new theme' }));
    const dialog = screen.getByRole('dialog', { name: 'Name your theme' });
    const name = within(dialog).getByLabelText('Theme name');
    await user.type(name, 'Ocean');
    await user.click(within(dialog).getByRole('button', { name: 'Create & edit' }));

    expect(await within(dialog).findByText('A saved theme already uses this name.')).toBeDefined();
    expect((name as HTMLInputElement).value).toBe('Ocean');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
  });

  test('keeps the create dialog open and renders an invalid name returned by the server', async () => {
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'POST') {
        return Response.json(
          ProblemDetailsSchema.parse({
            type: 'urn:ok:error:theme-name-invalid',
            title: 'The saved theme name is invalid.',
            status: 400,
            detail: 'invalid-chars',
          }),
          { status: 400 },
        );
      }
      return Response.json(listBody([]));
    };
    await renderTiles();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create new theme' }));
    const dialog = screen.getByRole('dialog', { name: 'Name your theme' });
    const name = within(dialog).getByLabelText('Theme name');
    await user.type(name, 'Ocean');
    await user.click(within(dialog).getByRole('button', { name: 'Create & edit' }));

    expect(await within(dialog).findByText('Enter a valid theme name.')).toBeDefined();
    expect((name as HTMLInputElement).value).toBe('Ocean');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
  });

  test('creates a named theme from the active palette and opens it for editing', async () => {
    const dracula = COLOR_THEMES.find((theme) => theme.id === 'dracula');
    if (!dracula?.scheme) throw new Error('Dracula must provide a base16 scheme.');
    let savedScheme: { name: string; variant: 'dark' | 'light'; palette: Record<string, string> };
    const assigned = vi.fn();
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === '/api/saved-theme' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as {
          name: string;
          scheme: typeof savedScheme;
        };
        savedScheme = request.scheme;
        expect(request.name).toBe("John's theme");
        return Response.json(
          SavedThemeSaveSuccessSchema.parse({
            id: 'saved-johns-theme',
            filename: 'johns-theme.yaml',
          }),
          { status: 201 },
        );
      }
      return Response.json(
        listBody(
          savedScheme
            ? [
                {
                  ok: true,
                  id: 'saved-johns-theme',
                  filename: 'johns-theme.yaml',
                  scheme: savedScheme,
                },
              ]
            : [],
        ),
      );
    };
    const { SavedThemesTiles } = await import('./SavedThemesTiles');
    render(
      <SavedThemesProvider>
        <SavedThemesTiles
          appearance={{ colorThemeLight: 'dracula', colorThemeDark: 'default' }}
          onAssign={assigned}
          slotMode="light"
          aria-label="Color theme"
        />
      </SavedThemesProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Create new theme' }));
    const dialog = screen.getByRole('dialog', { name: 'Name your theme' });
    const name = within(dialog).getByLabelText('Theme name');
    await user.type(name, "John's theme");
    expect(within(dialog).getByText('ID: johns-theme')).toBeDefined();
    await user.click(within(dialog).getByRole('button', { name: 'Create & edit' }));

    expect(await screen.findByRole('button', { name: "Hide John's theme editor" })).toBeDefined();
    expect(savedScheme).toMatchObject({
      name: "John's theme",
      variant: dracula.scheme.variant,
      palette: dracula.scheme.palette,
    });
    expect(assigned).toHaveBeenCalledWith(
      'light',
      'saved-johns-theme',
      { light: 'dracula', dark: 'default' },
      expect.arrayContaining([expect.objectContaining({ id: 'saved-johns-theme' })]),
    );
  });
});
