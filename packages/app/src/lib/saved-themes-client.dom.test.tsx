import {
  BASE16_SLOTS,
  base16ToTokens,
  ProblemDetailsSchema,
  SavedThemeDeleteSuccessSchema,
  SavedThemeSaveSuccessSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLOR_THEMES } from './color-themes';
import {
  deleteSavedTheme,
  fetchSavedThemes,
  SavedThemesProvider,
  saveSavedTheme,
  updateSavedTheme,
  useSavedThemes,
} from './saved-themes-client';
import { __resetServerInstanceStoreForTests, setServerInstanceId } from './server-instance-store';

type FetchFn = typeof globalThis.fetch;

let originalFetch: FetchFn;

function stubFetch(fn: FetchFn): void {
  globalThis.fetch = fn;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetServerInstanceStoreForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
  __resetServerInstanceStoreForTests();
});

/** A complete sixteen-slot palette with distinct `#rrggbb` values per slot. */
function palette(): Record<string, string> {
  return Object.fromEntries(
    BASE16_SLOTS.map((slot, i) => {
      const byte = (i * 16).toString(16).padStart(2, '0');
      return [slot, `#${byte}${byte}${byte}`];
    }),
  );
}

function scheme(name: string, variant: 'dark' | 'light' = 'dark') {
  return { name, variant, palette: palette() };
}

function usableEntry(id: string, name: string, variant: 'dark' | 'light' = 'dark') {
  return {
    ok: true as const,
    id,
    filename: `${id.replace('saved-', '')}.yaml`,
    scheme: scheme(name, variant),
  };
}

/**
 * Build a list-response body, validated through the SHARED wire schema so the
 * fixture can't drift from the contract the real server emits — a malformed
 * fixture throws here in setup rather than silently testing a shape the server
 * never sends.
 */
function listBody(themes: unknown[], truncated = false): unknown {
  return SavedThemesListSuccessSchema.parse({ themes, truncated });
}

function jsonResponse(body: unknown, status = 200): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('fetchSavedThemes', () => {
  test('adds a usable saved palette after the built-in palettes', async () => {
    stubFetch(jsonResponse(listBody([usableEntry('saved-midnight', 'Midnight', 'dark')])));

    const { authoritative, themes } = await fetchSavedThemes();

    expect(authoritative).toBe(true);
    expect(themes.slice(0, COLOR_THEMES.length)).toEqual(COLOR_THEMES);
    const theme = themes.at(-1);
    expect(theme?.id).toBe('saved-midnight');
    expect(theme?.label).toBe('Midnight');
    expect(theme?.scheme).toEqual(scheme('Midnight', 'dark'));
    expect(theme.toTokens?.()).toEqual(base16ToTokens(scheme('Midnight', 'dark')));
  });

  test('resolves each saved theme’s own light/dark variant so the two slots can differ', async () => {
    stubFetch(
      jsonResponse(
        listBody([
          usableEntry('saved-day', 'Day', 'light'),
          usableEntry('saved-night', 'Night', 'dark'),
        ]),
      ),
    );

    const { themes } = await fetchSavedThemes();

    expect(themes.find((t) => t.id === 'saved-day')?.kind).toBe('light');
    expect(themes.find((t) => t.id === 'saved-night')?.kind).toBe('dark');
  });

  test('carries a malformed file through as a warning rather than dropping it', async () => {
    stubFetch(
      jsonResponse(
        listBody([
          usableEntry('saved-good', 'Good'),
          { ok: false, filename: 'broken.yaml', id: 'saved-broken', code: 'missing-slots' },
        ]),
      ),
    );

    const { themes, warnings } = await fetchSavedThemes();

    expect(themes.at(-1)?.id).toBe('saved-good');
    expect(warnings).toEqual([
      { filename: 'broken.yaml', id: 'saved-broken', code: 'missing-slots' },
    ]);
  });

  test('reports truncation from the scan', async () => {
    stubFetch(jsonResponse(listBody([usableEntry('saved-a', 'A')], true)));

    const { truncated } = await fetchSavedThemes();

    expect(truncated).toBe(true);
  });

  test('an empty store returns the built-in list without an empty-state value', async () => {
    stubFetch(jsonResponse(listBody([], false)));

    expect(await fetchSavedThemes()).toEqual({
      authoritative: true,
      themes: COLOR_THEMES,
      warnings: [],
      truncated: false,
    });
  });

  test('degrades to built-ins-only when the server is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('network down');
    stubFetch(async () => {
      throw error;
    });

    expect(await fetchSavedThemes()).toEqual({
      authoritative: false,
      themes: COLOR_THEMES,
      warnings: [],
      truncated: false,
    });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'ok-saved-theme-request-failed',
      action: 'list',
      result: 'request-error',
      errorName: 'Error',
    });
  });

  test('degrades to built-ins-only on a non-2xx response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(jsonResponse({ error: 'boom' }, 500));

    expect(await fetchSavedThemes()).toEqual({
      authoritative: false,
      themes: COLOR_THEMES,
      warnings: [],
      truncated: false,
    });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'ok-saved-theme-request-failed',
      action: 'list',
      result: 'http-error',
      status: 500,
    });
  });

  test('ignores a response that fails the shared schema (client/server drift)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(jsonResponse({ themes: 'not-an-array', truncated: false }));

    expect(await fetchSavedThemes()).toEqual({
      authoritative: false,
      themes: COLOR_THEMES,
      warnings: [],
      truncated: false,
    });

    warn.mockRestore();
  });
});

describe('saveSavedTheme', () => {
  test('posts the shared save shape and validates the success response', async () => {
    let capturedPath = '';
    let capturedInit: RequestInit | undefined;
    const request: FetchFn = async (path, init) => {
      capturedPath = String(path);
      capturedInit = init;
      return new Response(
        JSON.stringify(
          SavedThemeSaveSuccessSchema.parse({
            id: 'saved-midnight',
            filename: 'midnight.yaml',
          }),
        ),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await saveSavedTheme(
      { name: 'midnight', scheme: scheme('midnight') },
      { request },
    );

    expect(result).toEqual({ ok: true, id: 'saved-midnight', filename: 'midnight.yaml' });
    expect(capturedPath).toBe('/api/saved-theme');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      name: 'midnight',
      scheme: scheme('midnight'),
    });
  });

  test('discriminates a taken name from other write failures', async () => {
    const problem = ProblemDetailsSchema.parse({
      type: 'urn:ok:error:theme-name-taken',
      title: 'A saved theme with that name already exists.',
      status: 409,
    });
    const result = await saveSavedTheme(
      { name: 'midnight', scheme: scheme('midnight') },
      { request: jsonResponse(problem, 409) },
    );

    expect(result).toEqual({ ok: false, reason: 'name-taken' });
  });

  test('carries the server’s specific id-grammar refusal', async () => {
    const problem = ProblemDetailsSchema.parse({
      type: 'urn:ok:error:theme-name-invalid',
      title: 'That name cannot be used as a theme id.',
      status: 400,
      detail: 'too-long',
    });
    const result = await saveSavedTheme(
      { name: 'a'.repeat(27), scheme: scheme('long') },
      { request: jsonResponse(problem, 400) },
    );

    expect(result).toEqual({ ok: false, reason: 'name-invalid', detail: 'too-long' });
  });

  test('collapses an unreadable server response to an unexpected failure', async () => {
    const result = await saveSavedTheme(
      { name: 'midnight', scheme: scheme('midnight') },
      { request: jsonResponse({ id: 42 }, 201) },
    );

    expect(result).toEqual({ ok: false, reason: 'unexpected' });
  });

  test('logs a request failure before returning an unexpected result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('offline');
    const result = await saveSavedTheme(
      { name: 'midnight', scheme: scheme('midnight') },
      { request: async () => Promise.reject(error) },
    );

    expect(result).toEqual({ ok: false, reason: 'unexpected' });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'ok-saved-theme-request-failed',
      action: 'save',
      result: 'request-error',
      errorName: 'Error',
    });
  });
});

describe('updateSavedTheme', () => {
  test('puts a complete scheme under the immutable saved-theme id', async () => {
    let capturedPath = '';
    let capturedInit: RequestInit | undefined;
    const request: FetchFn = async (path, init) => {
      capturedPath = String(path);
      capturedInit = init;
      return new Response(
        JSON.stringify(
          SavedThemeUpdateSuccessSchema.parse({
            id: 'saved-midnight',
            filename: 'midnight.yaml',
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await updateSavedTheme(
      { id: 'saved-midnight', scheme: scheme('Midnight revised') },
      { request },
    );

    expect(result).toEqual({ ok: true, id: 'saved-midnight', filename: 'midnight.yaml' });
    expect(capturedPath).toBe('/api/saved-theme');
    expect(capturedInit?.method).toBe('PUT');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      id: 'saved-midnight',
      scheme: scheme('Midnight revised'),
    });
  });

  test('discriminates a missing saved theme from an unexpected write failure', async () => {
    const problem = ProblemDetailsSchema.parse({
      type: 'urn:ok:error:not-found',
      title: 'Saved theme not found.',
      status: 404,
    });

    expect(
      await updateSavedTheme(
        { id: 'saved-absent', scheme: scheme('Absent') },
        { request: jsonResponse(problem, 404) },
      ),
    ).toEqual({ ok: false, reason: 'not-found' });
  });

  test('logs a request failure before returning an unexpected result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('offline');

    expect(
      await updateSavedTheme(
        { id: 'saved-midnight', scheme: scheme('Midnight') },
        { request: async () => Promise.reject(error) },
      ),
    ).toEqual({ ok: false, reason: 'unexpected' });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'ok-saved-theme-request-failed',
      action: 'update',
      result: 'request-error',
      errorName: 'Error',
    });
  });
});

describe('deleteSavedTheme', () => {
  test('deletes the encoded saved-theme id and validates the response', async () => {
    let capturedPath = '';
    let capturedInit: RequestInit | undefined;
    const request: FetchFn = async (path, init) => {
      capturedPath = String(path);
      capturedInit = init;
      return new Response(
        JSON.stringify(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'midnight.yaml',
            scheme: scheme('Midnight'),
          }),
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const result = await deleteSavedTheme('saved-midnight', { request });

    expect(result).toEqual({
      ok: true,
      existed: true,
      filename: 'midnight.yaml',
      scheme: scheme('Midnight'),
    });
    expect(capturedPath).toBe('/api/saved-theme?id=saved-midnight');
    expect(capturedInit?.method).toBe('DELETE');
  });

  test('collapses an unreadable server response to an unexpected failure', async () => {
    const result = await deleteSavedTheme('saved-midnight', {
      request: jsonResponse({ existed: 'yes' }),
    });

    expect(result).toEqual({ ok: false, reason: 'unexpected' });
  });

  test('logs a request failure before returning an unexpected result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('offline');
    const result = await deleteSavedTheme('saved-midnight', {
      request: async () => Promise.reject(error),
    });

    expect(result).toEqual({ ok: false, reason: 'unexpected' });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'ok-saved-theme-request-failed',
      action: 'delete',
      result: 'request-error',
      errorName: 'Error',
    });
  });
});

let context: ReturnType<typeof useSavedThemes> | null = null;

function SavedThemesProbe({ children }: { children?: ReactNode }) {
  context = useSavedThemes();
  return (
    <div>
      <span data-testid="loaded">{String(context.loaded)}</span>
      <span data-testid="load-error">{String(context.loadError)}</span>
      <span data-testid="themes">{context.themes.map((theme) => theme.label).join(',')}</span>
      <span data-testid="ocean-incarnation">
        {String(context.themeIncarnations['saved-ocean'] ?? 0)}
      </span>
      {children}
    </div>
  );
}

describe('SavedThemesProvider', () => {
  test('automatically retries an initial list failure', async () => {
    let requests = 0;
    stubFetch(async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: 'starting' }, { status: 503 })
        : Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'), {
      timeout: 1_000,
    });
    expect(requests).toBe(2);
    expect(screen.getByTestId('loaded').textContent).toBe('true');
    expect(screen.getByTestId('load-error').textContent).toBe('false');
  });

  test('stops automatically retrying after the configured attempts are exhausted', async () => {
    vi.useFakeTimers();
    let requests = 0;
    stubFetch(async () => {
      requests += 1;
      return Response.json({ error: 'starting' }, { status: 503 });
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(requests).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByTestId('loaded').textContent).toBe('false');
    expect(screen.getByTestId('load-error').textContent).toBe('true');
  });

  test('cancels a pending automatic retry when the provider unmounts', async () => {
    vi.useFakeTimers();
    let requests = 0;
    stubFetch(async () => {
      requests += 1;
      return Response.json({ error: 'starting' }, { status: 503 });
    });

    const view = render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toBe(1);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(requests).toBe(1);
  });

  test('starts a fresh retry sequence when the server epoch changes', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(response: Response) => void> = [];
    stubFetch(
      async () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    expect(resolvers).toHaveLength(1);

    act(() => setServerInstanceId('epoch-2'));
    expect(resolvers).toHaveLength(2);

    await act(async () => {
      resolvers[0]?.(Response.json(listBody([usableEntry('saved-old', 'Old')])));
      resolvers[1]?.(Response.json({ error: 'starting' }, { status: 503 }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('themes').textContent).not.toContain('Old');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(resolvers).toHaveLength(3);
    await act(async () => {
      resolvers[2]?.(Response.json(listBody([usableEntry('saved-new', 'New')])));
    });

    expect(screen.getByTestId('themes').textContent).toContain('New');
    expect(screen.getByTestId('themes').textContent).not.toContain('Old');
    expect(screen.getByTestId('load-error').textContent).toBe('false');
  });

  test('an authoritative manual refresh cancels a scheduled automatic retry', async () => {
    vi.useFakeTimers();
    let requests = 0;
    stubFetch(async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: 'starting' }, { status: 503 })
        : Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
    });
    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(requests).toBe(1);

    await act(async () => {
      await context?.refresh();
    });
    expect(requests).toBe(2);
    expect(screen.getByTestId('load-error').textContent).toBe('false');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(requests).toBe(2);
    expect(screen.getByTestId('load-error').textContent).toBe('false');
  });

  test('keeps prepaint readiness false after an initial failed list and recovers on retry', async () => {
    let requestSucceeds = false;
    stubFetch(async () => {
      if (!requestSucceeds) return Response.json({ error: 'offline' }, { status: 503 });
      return Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('load-error').textContent).toBe('true'));
    expect(screen.getByTestId('loaded').textContent).toBe('false');
    expect(screen.getByTestId('themes').textContent).not.toContain('Ocean');

    requestSucceeds = true;
    await act(async () => {
      await context?.refresh();
    });

    expect(screen.getByTestId('loaded').textContent).toBe('true');
    expect(screen.getByTestId('load-error').textContent).toBe('false');
    expect(screen.getByTestId('themes').textContent).toContain('Ocean');
  });

  test('preserves the last authoritative registry when a later list request fails', async () => {
    let requestSucceeds = true;
    stubFetch(async () =>
      requestSucceeds
        ? Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]))
        : Response.json({ error: 'offline' }, { status: 503 }),
    );

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'));

    requestSucceeds = false;
    await act(async () => {
      await context?.refresh();
    });

    expect(screen.getByTestId('loaded').textContent).toBe('true');
    expect(screen.getByTestId('load-error').textContent).toBe('true');
    expect(screen.getByTestId('themes').textContent).toContain('Ocean');
  });

  test('keeps an optimistic update when its follow-up list request fails', async () => {
    let listRequests = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === 'PUT') {
        return Response.json(
          SavedThemeUpdateSuccessSchema.parse({
            id: 'saved-ocean',
            filename: 'ocean.yaml',
          }),
        );
      }
      listRequests += 1;
      if (listRequests === 1) {
        return Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
      }
      return Response.json({ error: 'offline' }, { status: 503 });
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'));

    await act(async () => {
      await context?.updateTheme({ id: 'saved-ocean', scheme: scheme('Ocean revised', 'light') });
      await context?.refresh();
    });

    expect(screen.getByTestId('load-error').textContent).toBe('true');
    expect(screen.getByTestId('themes').textContent).toContain('Ocean revised');
    expect(screen.getByTestId('themes').textContent).not.toContain('Ocean,');
  });

  test('keeps an optimistic delete when its follow-up list request fails', async () => {
    let listRequests = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === 'DELETE') {
        return Response.json(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'ocean.yaml',
            scheme: scheme('Ocean'),
          }),
        );
      }
      listRequests += 1;
      if (listRequests === 1) {
        return Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
      }
      return Response.json({ error: 'offline' }, { status: 503 });
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'));

    await act(async () => {
      await context?.deleteTheme('saved-ocean');
      await context?.refresh();
    });

    expect(screen.getByTestId('load-error').textContent).toBe('true');
    expect(screen.getByTestId('themes').textContent).not.toContain('Ocean');
  });

  test('removes an already-deleted theme when its follow-up list request fails', async () => {
    let listRequests = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === 'DELETE') {
        return Response.json(SavedThemeDeleteSuccessSchema.parse({ existed: false }));
      }
      listRequests += 1;
      if (listRequests === 1) {
        return Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
      }
      return Response.json({ error: 'offline' }, { status: 503 });
    });

    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'));

    await act(async () => {
      await context?.deleteTheme('saved-ocean');
      await context?.refresh();
    });

    expect(screen.getByTestId('load-error').textContent).toBe('true');
    expect(screen.getByTestId('themes').textContent).not.toContain('Ocean');
  });

  test('queues one trailing list while a refresh is in flight and returns a promise covering it', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    stubFetch(
      async () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));

    let coveredRefresh: Promise<void> | undefined;
    act(() => {
      coveredRefresh = context?.refresh();
      void context?.refresh();
    });
    let settled = false;
    void coveredRefresh?.then(() => {
      settled = true;
    });

    await act(async () => {
      resolvers[0]?.(Response.json(listBody([])));
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    expect(settled).toBe(false);

    await act(async () => {
      resolvers[1]?.(Response.json(listBody([usableEntry('saved-late', 'Late')])));
      await coveredRefresh;
    });

    expect(resolvers).toHaveLength(2);
    expect(settled).toBe(true);
    expect(screen.getByTestId('themes').textContent).toContain('Late');
  });

  test('serializes delete behind pending updates for the same saved theme', async () => {
    let resolveUpdate: ((response: Response) => void) | undefined;
    const methods: string[] = [];
    stubFetch(async (_input, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveUpdate = resolve;
        });
      }
      if (method === 'DELETE') {
        return Response.json(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'latest.yaml',
            scheme: scheme('Latest'),
          }),
        );
      }
      return Response.json(listBody([]));
    });
    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(methods).toContain('GET'));

    let updatePromise: ReturnType<NonNullable<typeof context>['updateTheme']> | undefined;
    let deletePromise: ReturnType<NonNullable<typeof context>['deleteTheme']> | undefined;
    act(() => {
      updatePromise = context?.updateTheme({
        id: 'saved-latest',
        scheme: scheme('Latest'),
      });
      deletePromise = context?.deleteTheme('saved-latest');
    });
    await waitFor(() => expect(methods.filter((method) => method === 'PUT')).toHaveLength(1));
    expect(methods).not.toContain('DELETE');

    await act(async () => {
      resolveUpdate?.(
        Response.json(
          SavedThemeUpdateSuccessSchema.parse({
            id: 'saved-latest',
            filename: 'latest.yaml',
          }),
        ),
      );
      await updatePromise;
      await deletePromise;
    });

    expect(methods.slice(-2)).toEqual(['PUT', 'DELETE']);
  });

  test('increments an id incarnation when a saved theme is deleted', async () => {
    stubFetch(async (_input, init) => {
      if (init?.method === 'DELETE') {
        return Response.json(
          SavedThemeDeleteSuccessSchema.parse({
            existed: true,
            filename: 'ocean.yaml',
            scheme: scheme('Ocean'),
          }),
        );
      }
      return Response.json(listBody([usableEntry('saved-ocean', 'Ocean')]));
    });
    render(
      <SavedThemesProvider>
        <SavedThemesProbe />
      </SavedThemesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('themes').textContent).toContain('Ocean'));
    expect(screen.getByTestId('ocean-incarnation').textContent).toBe('0');

    await act(async () => {
      await context?.deleteTheme('saved-ocean');
    });

    expect(context?.themeIncarnations['saved-ocean']).toBe(1);
    expect(screen.getByTestId('ocean-incarnation').textContent).toBe('1');
  });
});
