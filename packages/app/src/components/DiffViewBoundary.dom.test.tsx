import { SyncResolveConflictRequestSchema } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';

vi.doMock('sonner', () => ({
  toast: { error: () => {}, success: () => {}, info: () => {} },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

const { DiffViewBoundary } = await import('./DiffViewBoundary');

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

const fetchCalls: CapturedFetch[] = [];

function makeProvider(initialBody: string) {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, initialBody);
  return { document: doc } as unknown as Parameters<typeof DiffViewBoundary>[0]['provider'];
}

type ConflictKind = 'both-modified' | 'delete-modify' | 'modify-delete';

function strategyFetch(kind: ConflictKind, resolvePending?: Promise<unknown>) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url === '/api/sync/conflicts') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url.startsWith('/api/sync/conflict-content')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            file: 'foo.md',
            base: 'base content\n',
            ours: kind === 'delete-modify' ? '' : 'our modification\n',
            theirs: kind === 'modify-delete' ? '' : 'their modification\n',
            kind,
            lifecycleStatus: 'conflict',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url === '/api/sync/resolve-conflict') {
      const ok = new Response('{}', { status: 200 });
      return resolvePending ? resolvePending.then(() => ok) : Promise.resolve(ok);
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

function lastResolveBody(): { file?: string; strategy?: string } {
  const call = fetchCalls.find((c) => c.url === '/api/sync/resolve-conflict');
  return SyncResolveConflictRequestSchema.parse(JSON.parse(String(call?.init?.body ?? '{}')));
}

describe('DiffViewBoundary (Tier-3 mount)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [
                { file: 'docs/notes.md', detectedAt: '2026-05-20T00:00:00.000Z' },
                { file: 'logs/entry.md', detectedAt: '2026-05-20T00:00:00.000Z' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/notes.md',
              base: '# Base\nbase paragraph\n',
              ours: '# Server-ours\nfrom-git-index\n',
              theirs: '# Theirs\nteam paragraph\n',
              lifecycleStatus: 'conflict',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleWarnSpy.mockRestore();
  });

  test('fetches conflict-content with ?source=ytext and renders the diff', async () => {
    const provider = makeProvider('# My Y.Text bytes\nclient-side\n');
    render(<DiffViewBoundary docName="docs/notes" provider={provider} />);

    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched).toBeTruthy();
      expect(fetched?.url).toContain('source=ytext');
      expect(fetched?.url).toContain('file=docs%2Fnotes.md');
    });

    expect(screen.queryByText(/Couldn't load conflict content/i)).toBeNull();
  });

  test('carries the stale-save kind from conflict content into the diff view', async () => {
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body =
        url === '/api/sync/conflicts'
          ? { conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }] }
          : {
              file: 'foo.md',
              base: '',
              ours: 'Protected current version.\n',
              theirs: 'Blocked older save.\n',
              kind: 'both-modified',
              conflictKind: 'stale-external-write',
              lifecycleStatus: 'conflict',
            };
      return Promise.resolve(Response.json(body));
    };
    render(
      <DiffViewBoundary docName="foo" provider={makeProvider('Protected current version.\n')} />,
    );

    const alert = await screen.findByRole('status');
    expect(alert.textContent).toContain('Current is the version OpenKnowledge protected.');
    expect(alert.textContent).toContain('Incoming is the restored version.');
    expect(screen.queryByText(/No common ancestor/)).toBeNull();
  });

  test.each([undefined, 'git', 'future-conflict'])(
    'diagnoses only an unrecognized conflict discriminator: %j',
    async (conflictKind) => {
      globalThis.fetch = (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return Promise.resolve(
          Response.json(
            url === '/api/sync/conflicts'
              ? { conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }] }
              : {
                  file: 'foo.md',
                  base: 'Original content.\n',
                  ours: 'Current content.\n',
                  theirs: 'Incoming content.\n',
                  kind: 'both-modified',
                  conflictKind,
                  lifecycleStatus: 'conflict',
                },
          ),
        );
      };
      render(<DiffViewBoundary docName="foo" provider={makeProvider('Current content.\n')} />);
      expect(await screen.findByRole('button', { name: /^Accept current/ })).toBeTruthy();
      const diagnostics = consoleWarnSpy.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .filter((event) => event.event === 'conflict-discriminator-unrecognized');
      expect(diagnostics).toEqual(
        conflictKind === 'future-conflict'
          ? [
              {
                event: 'conflict-discriminator-unrecognized',
                file: 'foo.md',
                receivedConflictKind: conflictKind,
              },
            ]
          : [],
      );
    },
  );

  test.each([
    {
      conflictKind: 'stale-external-write',
      ours: '',
      theirs: 'Older content.\n',
      choice: 'current',
      strategy: 'content',
      content: '',
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Current content.\n',
      theirs: '',
      choice: 'incoming',
      strategy: 'theirs',
      content: undefined,
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Current content.\n',
      theirs: 'Older content.\n',
      choice: 'current',
      strategy: 'content',
      content: 'Current content.\n',
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Current content.\n',
      theirs: 'Older content.\n',
      choice: 'incoming',
      strategy: 'theirs',
      content: undefined,
    },
    {
      conflictKind: 'git',
      ours: '',
      theirs: 'Older content.\n',
      choice: 'current',
      strategy: 'content',
      content: '',
    },
    {
      conflictKind: 'git',
      ours: 'Current content.\n',
      theirs: '',
      choice: 'incoming',
      strategy: 'content',
      content: '',
    },
    {
      conflictKind: 'stale-external-write',
      ours: '',
      theirs: '',
      choice: 'current',
      strategy: 'content',
      content: '',
    },
    {
      conflictKind: 'stale-external-write',
      ours: '',
      theirs: '',
      choice: 'incoming',
      strategy: 'theirs',
      content: undefined,
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Same content.\n',
      theirs: 'Same content.\n',
      choice: 'incoming',
      strategy: 'theirs',
      content: undefined,
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Same content.\n',
      theirs: 'Same content.\n',
      choice: 'current',
      strategy: 'content',
      content: 'Same content.\n',
    },
    {
      conflictKind: 'stale-external-write',
      ours: 'Current content.\n',
      theirs: 'Older content.\n',
      choice: 'both',
      strategy: 'content',
      content: 'Current content.\nOlder content.\n',
    },
  ])(
    'resolves $conflictKind $choice via $strategy without changing selected bytes',
    async ({ conflictKind, ours, theirs, choice, strategy, content }) => {
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        fetchCalls.push({ url, init });
        if (url === '/api/sync/conflicts') {
          return Promise.resolve(
            Response.json({
              conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z', conflictKind }],
            }),
          );
        }
        if (url.startsWith('/api/sync/conflict-content')) {
          return Promise.resolve(
            Response.json({
              file: 'foo.md',
              base: conflictKind === 'stale-external-write' ? theirs : 'Original content.\n',
              ours,
              theirs,
              kind: 'both-modified',
              conflictKind,
              lifecycleStatus: 'conflict',
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      };
      render(<DiffViewBoundary docName="foo" provider={makeProvider(ours)} />);

      const choiceButton = await screen.findByRole('button', {
        name: new RegExp(`^Accept ${choice}`),
      });
      expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull();
      fireEvent.click(choiceButton);
      fireEvent.click(await screen.findByRole('button', { name: 'Apply changes' }));

      await waitFor(() => {
        expect(lastResolveBody()).toEqual({
          file: 'foo.md',
          strategy,
          ...(content === undefined ? {} : { content }),
        });
      });
    },
  );

  test('emits editor-area-swap-to-diffview on mount and -from on unmount', async () => {
    const provider = makeProvider('seed\n');
    const { unmount } = render(<DiffViewBoundary docName="logs/entry" provider={provider} />);

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

  test('threads .mdx extension from useConflicts when the doc is .mdx', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/note.mdx', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/note.mdx',
              base: '',
              ours: '',
              theirs: '',
              lifecycleStatus: 'conflict',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('mdx body\n');
    render(<DiffViewBoundary docName="docs/note" provider={provider} />);

    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched?.url).toContain('file=docs%2Fnote.mdx');
    });
  });

  test('renders error fallback and hides actions when conflict-content fetch fails', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/missing.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/missing" provider={provider} />);

    await screen.findByText(/Couldn't load conflict content for docs\/missing\.md/i);
    const failureLog = consoleWarnSpy.mock.calls
      .map((c) => c[0])
      .find((e: unknown) => typeof e === 'string' && e.includes('conflict-content-fetch-failed'));
    expect(failureLog).toBeTruthy();
  });

  test('defers conflict-content fetch when conflicts list is empty (race window)', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(JSON.stringify({ conflicts: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(JSON.stringify({ file: '', base: '', ours: '', theirs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/note" provider={provider} />);

    await waitFor(() => {
      const conflictsFetch = fetchCalls.find((c) => c.url === '/api/sync/conflicts');
      expect(conflictsFetch).toBeTruthy();
    });
    expect(screen.queryByText(/Loading conflict for/i)).not.toBeNull();
    const contentFetch = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
    expect(contentFetch).toBeUndefined();
  });

  test('delete-modify (DU) renders Keep deletion + Restore affordances, not unified DiffView', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'foo.md',
              base: 'base content\n',
              ours: '',
              theirs: 'their modification\n',
              lifecycleStatus: 'conflict',
              kind: 'delete-modify',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="foo" provider={provider} />);

    const keepDeletion = await screen.findByRole('button', { name: /keep file deleted/i });
    expect(keepDeletion).toBeTruthy();

    const restore = await screen.findByRole('button', { name: /restore/i });
    expect(restore).toBeTruthy();
  });

  test('modify-delete (UD) renders Keep my version + Accept their deletion affordances', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'foo.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'foo.md',
              base: 'base content\n',
              ours: 'our modification\n',
              theirs: '',
              lifecycleStatus: 'conflict',
              kind: 'modify-delete',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Our version\n');
    render(<DiffViewBoundary docName="foo" provider={provider} />);

    const keepMine = await screen.findByRole('button', { name: /keep my version/i });
    expect(keepMine).toBeTruthy();

    const acceptDeletion = await screen.findByRole('button', { name: /accept their deletion/i });
    expect(acceptDeletion).toBeTruthy();
  });

  test('both-modified (regression) still renders the unified DiffView, NOT delete-prompt affordances', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [{ file: 'docs/notes.md', detectedAt: '2026-05-20T00:00:00.000Z' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file: 'docs/notes.md',
              base: 'base content\n',
              ours: 'our version\n',
              theirs: 'their version\n',
              lifecycleStatus: 'conflict',
              kind: 'both-modified',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === '/api/sync/resolve-conflict') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };

    const provider = makeProvider('# Our version\n');
    render(<DiffViewBoundary docName="docs/notes" provider={provider} />);

    await waitFor(() => {
      const fetched = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
      expect(fetched).toBeTruthy();
    });

    expect(screen.queryByRole('button', { name: /keep file deleted/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /accept their deletion/i })).toBeNull();
  });

  test('delete-modify publishes --conflict-footer-height while mounted, removes on unmount', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    const { unmount } = render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

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
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    const { unmount } = render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

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
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep file deleted/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'delete' });
  });

  test('delete-modify: "Restore with remote changes" dispatches strategy: theirs', async () => {
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /restore with remote changes/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'theirs' });
  });

  test('modify-delete: "Keep my version" dispatches strategy: mine (never delete)', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    fireEvent.click(await screen.findByRole('button', { name: /keep my version/i }));
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url === '/api/sync/resolve-conflict')).toBe(true),
    );
    expect(lastResolveBody()).toMatchObject({ file: 'foo.md', strategy: 'mine' });
  });

  test('modify-delete: "Accept their deletion" dispatches strategy: delete', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
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
    globalThis.fetch = strategyFetch('delete-modify', pending) as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);

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
    globalThis.fetch = strategyFetch('delete-modify') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    expect(await screen.findByText(/you deleted/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep file deleted/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore with remote changes/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show upstream changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  test('modify-delete (UD) renders header / content / footer with no collapsible-preview chrome', async () => {
    globalThis.fetch = strategyFetch('modify-delete') as typeof fetch;
    render(<DiffViewBoundary docName="foo" provider={makeProvider('x\n')} />);
    expect(await screen.findByText(/you modified/i, { exact: false, selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep my version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /accept their deletion/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /show your local changes/i })).toBeNull();
    expect(screen.queryByTestId('conflict-preview-trigger')).toBeNull();
  });

  test('defers conflict-content fetch when other conflicts loaded but this docs entry missing', async () => {
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url === '/api/sync/conflicts') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              conflicts: [
                {
                  file: 'other/doc.md',
                  detectedAt: '2026-05-19T00:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.startsWith('/api/sync/conflict-content')) {
        return Promise.resolve(
          new Response(JSON.stringify({ file: '', base: '', ours: '', theirs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const provider = makeProvider('# Anything\n');
    render(<DiffViewBoundary docName="docs/mdx-note" provider={provider} />);

    await waitFor(() => {
      const conflictsFetch = fetchCalls.find((c) => c.url === '/api/sync/conflicts');
      expect(conflictsFetch).toBeTruthy();
    });
    expect(screen.queryByText(/Loading conflict for/i)).not.toBeNull();
    const contentFetch = fetchCalls.find((c) => c.url.startsWith('/api/sync/conflict-content'));
    expect(contentFetch).toBeUndefined();
  });
});
