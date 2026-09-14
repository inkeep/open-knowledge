import type { ConflictEntryWire } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.doMock('sonner', () => ({
  toast: { error: () => {}, success: () => {}, info: () => {}, warning: () => {} },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const { DiffViewBoundary } = await import('./DiffViewBoundary');

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

const fetchCalls: CapturedFetch[] = [];

function entry(file: string, overrides: Partial<ConflictEntryWire> = {}): ConflictEntryWire {
  return {
    file,
    detectedAt: '2026-05-20T00:00:00.000Z',
    conflict: 'merge-native',
    docName: file.replace(/\.mdx?$/, ''),
    ...overrides,
  } as ConflictEntryWire;
}

type ConflictShape = 'both-modified' | 'delete-modify' | 'modify-delete';

function contentResponse(
  file: string,
  shape: ConflictShape,
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      file,
      base: 'base content\n',
      ours: shape === 'delete-modify' ? '' : 'our modification\n',
      theirs: shape === 'modify-delete' ? '' : 'their modification\n',
      kind: shape,
      conflict: 'merge-native',
      resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

function strategyFetch(
  file: string,
  shape: ConflictShape,
  options: { resolvePending?: Promise<unknown>; resolutionOptions?: string[] } = {},
) {
  stubFetch((url) => {
    if (url.startsWith('/api/sync/conflict-content')) {
      return contentResponse(
        file,
        shape,
        options.resolutionOptions === undefined
          ? {}
          : { resolutionOptions: options.resolutionOptions },
      );
    }
    if (url === '/api/sync/resolve-conflict') {
      const ok = new Response('{}', { status: 200 });
      return options.resolvePending ? options.resolvePending.then(() => ok) : ok;
    }
    return new Response('not found', { status: 404 });
  });
}

function lastResolveBody(): { file?: string; strategy?: string } {
  const call = fetchCalls.find((c) => c.url === '/api/sync/resolve-conflict');
  return JSON.parse(String(call?.init?.body ?? '{}'));
}

function contentFetches(): CapturedFetch[] {
  return fetchCalls.filter((c) => c.url.startsWith('/api/sync/conflict-content'));
}

describe('DiffViewBoundary (Tier-3 mount)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchCalls.length = 0;
    stubFetch((url) => {
      if (url.startsWith('/api/sync/conflict-content')) {
        return new Response(
          JSON.stringify({
            file: 'docs/notes.md',
            base: '# Base\nbase paragraph\n',
            ours: '# Server-ours\nfrom-git-index\n',
            theirs: '# Theirs\nteam paragraph\n',
            kind: 'both-modified',
            conflict: 'merge-native',
            resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/sync/resolve-conflict') return new Response('{}', { status: 200 });
      return new Response('not found', { status: 404 });
    });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('issues the stage fetch on the first effect when the entry is present at mount', async () => {
    render(<DiffViewBoundary docName="docs/notes" conflict={entry('docs/notes.md')} />);

    await waitFor(() => {
      expect(contentFetches().length).toBe(1);
    });
    const fetched = contentFetches()[0];
    expect(fetched?.url).toContain('source=ytext');
    expect(fetched?.url).toContain('file=docs%2Fnotes.md');
    expect(fetchCalls.some((c) => c.url === '/api/sync/conflicts')).toBe(false);
    expect(screen.queryByText(/Couldn't load conflict content/i)).toBeNull();
  });

  test('bounds the conflict-content fetch with an abort signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    render(<DiffViewBoundary docName="docs/notes" conflict={entry('docs/notes.md')} />);

    await waitFor(() => {
      expect(contentFetches().length).toBe(1);
    });
    const fetched = contentFetches()[0];
    expect(fetched?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetched?.init?.signal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(20_000);
  });

  test('refetches the stages when the file or its detection time changes', async () => {
    const raised = entry('docs/notes.md');
    const { rerender } = render(<DiffViewBoundary docName="docs/notes" conflict={raised} />);
    await waitFor(() => {
      expect(contentFetches().length).toBe(1);
    });

    rerender(<DiffViewBoundary docName="docs/notes" conflict={raised} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contentFetches().length).toBe(1);

    rerender(
      <DiffViewBoundary
        docName="docs/notes"
        conflict={entry('docs/notes.md', { detectedAt: '2026-05-20T00:05:00.000Z' })}
      />,
    );
    await waitFor(() => {
      expect(contentFetches().length).toBe(2);
    });

    rerender(<DiffViewBoundary docName="docs/other" conflict={entry('docs/other.md')} />);
    await waitFor(() => {
      expect(contentFetches().length).toBe(3);
    });
  });

  test('emits editor-area-swap-to-diffview on mount and -from on unmount', async () => {
    const { unmount } = render(
      <DiffViewBoundary docName="logs/entry" conflict={entry('logs/entry.md')} />,
    );

    await waitFor(() => {
      const events = consoleWarnSpy.mock.calls.map((c) => c[0]);
      expect(
        events.some(
          (e: unknown) => typeof e === 'string' && e.includes('editor-area-swap-to-diffview'),
        ),
      ).toBe(true);
    });

    unmount();

    const eventsAfter = consoleWarnSpy.mock.calls.map((c) => c[0]);
    expect(
      eventsAfter.some(
        (e: unknown) => typeof e === 'string' && e.includes('editor-area-swap-from-diffview'),
      ),
    ).toBe(true);
  });

  test('uses the entry file path verbatim, including a .mdx extension', async () => {
    strategyFetch('docs/note.mdx', 'both-modified');
    render(<DiffViewBoundary docName="docs/note" conflict={entry('docs/note.mdx')} />);

    await waitFor(() => {
      expect(contentFetches()[0]?.url).toContain('file=docs%2Fnote.mdx');
    });
  });

  test('renders error fallback and hides actions when conflict-content fetch fails', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));

    render(<DiffViewBoundary docName="docs/missing" conflict={entry('docs/missing.md')} />);

    await screen.findByText(/Couldn't load conflict content for docs\/missing\.md/i);
    const failureLog = consoleWarnSpy.mock.calls
      .map((c) => c[0])
      .find((e: unknown) => typeof e === 'string' && e.includes('conflict-content-fetch-failed'));
    expect(failureLog).toBeTruthy();
  });

  test('delete-modify (DU) renders Keep deletion + Restore affordances, not unified DiffView', async () => {
    strategyFetch('foo.md', 'delete-modify');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    expect(await screen.findByRole('button', { name: /keep file deleted/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /restore/i })).toBeTruthy();
  });

  test('delete-modify withholds the theirs affordance when resolutionOptions omits it', async () => {
    strategyFetch('foo.md', 'delete-modify', { resolutionOptions: ['mine', 'content', 'delete'] });
    render(
      <DiffViewBoundary
        docName="foo"
        conflict={entry('foo.md', { conflict: 'reconcile', reason: 'disk-markers' })}
      />,
    );

    expect(await screen.findByRole('button', { name: /keep file deleted/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /restore with remote changes/i })).toBeNull();
  });

  test('modify-delete (UD) renders Keep my version + Accept their deletion affordances', async () => {
    strategyFetch('foo.md', 'modify-delete');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    expect(await screen.findByRole('button', { name: /keep my version/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /accept their deletion/i })).toBeTruthy();
  });

  test('both-modified (regression) still renders the unified DiffView, NOT delete-prompt affordances', async () => {
    strategyFetch('docs/notes.md', 'both-modified');
    render(<DiffViewBoundary docName="docs/notes" conflict={entry('docs/notes.md')} />);

    await waitFor(() => {
      expect(contentFetches().length).toBe(1);
    });

    expect(screen.queryByRole('button', { name: /keep file deleted/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /accept their deletion/i })).toBeNull();
  });

  test('delete-modify publishes --conflict-footer-height while mounted, removes on unmount', async () => {
    strategyFetch('foo.md', 'delete-modify');
    const { unmount } = render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    await screen.findByRole('button', { name: /keep file deleted/i });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe(
        '0px',
      );
    });

    unmount();
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });

  test('modify-delete publishes --conflict-footer-height while mounted, removes on unmount', async () => {
    strategyFetch('foo.md', 'modify-delete');
    const { unmount } = render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    await screen.findByRole('button', { name: /accept their deletion/i });
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe(
        '0px',
      );
    });

    unmount();
    expect(document.documentElement.style.getPropertyValue('--conflict-footer-height')).toBe('');
  });

  test('delete-modify: "Keep deletion" dispatches strategy: delete', async () => {
    strategyFetch('foo.md', 'delete-modify');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep file deleted/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'delete' });
  });

  test('delete-modify: "Restore with remote changes" dispatches strategy: theirs', async () => {
    strategyFetch('foo.md', 'delete-modify');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    fireEvent.click(await screen.findByRole('button', { name: /restore with remote changes/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'theirs' });
  });

  test('modify-delete: "Keep my version" dispatches strategy: mine (never delete)', async () => {
    strategyFetch('foo.md', 'modify-delete');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep my version/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'mine' });
  });

  test('modify-delete: "Accept their deletion" dispatches strategy: delete', async () => {
    strategyFetch('foo.md', 'modify-delete');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    fireEvent.click(await screen.findByRole('button', { name: /accept their deletion/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'delete' });
  });

  test('resolve buttons disable while a dispatch is in flight', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    strategyFetch('foo.md', 'delete-modify', { resolvePending: pending });
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    const keep = (await screen.findByRole('button', {
      name: /keep file deleted/i,
    })) as HTMLButtonElement;
    const restore = screen.getByRole('button', {
      name: /restore with remote changes/i,
    }) as HTMLButtonElement;
    expect(keep.disabled).toBe(false);

    fireEvent.click(keep);

    await waitFor(() => expect(keep.disabled).toBe(true));
    expect(restore.disabled).toBe(true);

    release?.();
  });

  test('delete-modify (DU) renders header / content / footer with no collapsible-preview chrome', async () => {
    strategyFetch('foo.md', 'delete-modify');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    expect(await screen.findByText(/you deleted/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep file deleted/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore with remote changes/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show upstream changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  test('modify-delete (UD) renders header / content / footer with no collapsible-preview chrome', async () => {
    strategyFetch('foo.md', 'modify-delete');
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);
    expect(await screen.findByText(/you modified/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep my version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /accept their deletion/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show your local changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  test('a both-modified conflict that withholds content offers the wholesale choice instead', async () => {
    strategyFetch('big.md', 'both-modified', { resolutionOptions: ['mine', 'theirs', 'delete'] });
    render(
      <DiffViewBoundary
        docName="big"
        conflict={entry('big.md', { conflict: 'reconcile', reason: 'refused-too-large' })}
      />,
    );

    expect(await screen.findByRole('button', { name: /keep my version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use their version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete the file/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Accept current/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
  });

  test('the wholesale choice dispatches the strategy the server offered', async () => {
    strategyFetch('big.md', 'both-modified', { resolutionOptions: ['mine', 'theirs', 'delete'] });
    render(
      <DiffViewBoundary
        docName="big"
        conflict={entry('big.md', { conflict: 'reconcile', reason: 'refused-too-large' })}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /use their version/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'big.md', strategy: 'theirs' });
  });

  test('a stage body with no resolutionOptions offers nothing rather than guessing', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/sync/conflict-content')) {
        return new Response(
          JSON.stringify({
            file: 'docs/skew.md',
            base: 'base\n',
            ours: 'ours\n',
            theirs: 'theirs\n',
            kind: 'delete-modify',
            conflict: 'reconcile',
            reason: 'disk-markers',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<DiffViewBoundary docName="docs/skew" conflict={entry('docs/skew.md')} />);

    await screen.findByText(/Couldn't load conflict content for docs\/skew\.md/i);
    expect(screen.queryByRole('button', { name: /restore with remote changes/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /keep file deleted/i })).toBeNull();
    expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(false);
  });

  test('a stage body whose resolutionOptions are malformed offers nothing', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/sync/conflict-content')) {
        return new Response(
          JSON.stringify({
            file: 'docs/skew.md',
            base: 'base\n',
            ours: 'ours\n',
            theirs: 'theirs\n',
            kind: 'delete-modify',
            conflict: 'reconcile',
            reason: 'disk-markers',
            resolutionOptions: 'mine',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    render(<DiffViewBoundary docName="docs/skew" conflict={entry('docs/skew.md')} />);

    await screen.findByText(/Couldn't load conflict content for docs\/skew\.md/i);
    expect(screen.queryByRole('button', { name: /restore with remote changes/i })).toBeNull();
  });

  test('resolve buttons come back after a dispatch that succeeds without unmounting', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    strategyFetch('foo.md', 'delete-modify', { resolvePending: pending });
    render(<DiffViewBoundary docName="foo" conflict={entry('foo.md')} />);

    const keep = (await screen.findByRole('button', {
      name: /keep file deleted/i,
    })) as HTMLButtonElement;
    const restore = screen.getByRole('button', {
      name: /restore with remote changes/i,
    }) as HTMLButtonElement;

    fireEvent.click(keep);
    await waitFor(() => expect(keep.disabled).toBe(true));

    release?.();

    await waitFor(() => expect(keep.disabled).toBe(false));
    expect(restore.disabled).toBe(false);
  });

  test('Apply reaches the endpoint once, through the real boundary wiring', async () => {
    const resolvePosts: string[] = [];
    let releaseResolve: (() => void) | null = null;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/sync/resolve-conflict')) {
        resolvePosts.push(url);
        return new Promise<Response>((resolveFetch) => {
          releaseResolve = () => resolveFetch(new Response('{}', { status: 200 }));
        });
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'notes/roadmap.md',
              kind: 'both-modified',
              conflict: 'merge-native',
              resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
              base: '# Roadmap\n\n- Ship date: October 14\n',
              ours: '# Roadmap\n\n- Ship date: October 21\n',
              theirs: '# Roadmap\n\n- Ship date: Q4\n',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    render(<DiffViewBoundary docName="notes/roadmap" conflict={entry('notes/roadmap.md')} />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /^Accept current/ }).length).toBeGreaterThan(0);
    });
    screen.getAllByRole('button', { name: /^Accept current/ })[0].click();

    const apply = await screen.findByRole('button', { name: 'Apply changes' });
    apply.click();
    await act(async () => {});
    apply.click();
    await act(async () => {});

    expect(resolvePosts).toHaveLength(1);

    releaseResolve?.();
    await act(async () => {});
  });
});
