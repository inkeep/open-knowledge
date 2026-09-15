import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ConflictsProvider,
  ConflictsProviderMissingError,
  useConflicts,
  useDocConflict,
} from './use-conflicts';

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

let fetchCalls: CapturedFetch[] = [];
let fetchResponse: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ conflicts: [] }), { status: 200 });

function installFetchStub() {
  fetchCalls = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return Promise.resolve(fetchResponse());
  };
}

function conflictsFetchCount(): number {
  return fetchCalls.filter((call) => call.url === '/api/sync/conflicts').length;
}

function Probe() {
  const { conflicts, loading, error } = useConflicts();
  return (
    <>
      <span data-testid="count">{conflicts.length}</span>
      <span data-testid="files">{conflicts.map((c) => c.file).join(',')}</span>
      <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
      <span data-testid="error">{error ?? 'none'}</span>
    </>
  );
}

let consumerRenders = 0;

function RenderCountProbe() {
  const { conflicts } = useConflicts();
  consumerRenders += 1;
  return <span data-testid="render-count-files">{conflicts.length}</span>;
}

function DocProbe({ docName, testId }: { docName: string | null; testId: string }) {
  const entry = useDocConflict(docName);
  return <span data-testid={testId}>{entry === null ? 'none' : entry.file}</span>;
}

function EntryEffectProbe({ docName, testId }: { docName: string; testId: string }) {
  const entry = useDocConflict(docName);
  const [effectRuns, setEffectRuns] = useState(0);
  useEffect(() => {
    if (entry === null) return;
    setEffectRuns((runs) => runs + 1);
  }, [entry]);
  return <span data-testid={testId}>{effectRuns}</span>;
}

function signalSyncStatus() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('open-knowledge:documents-changed', {
        detail: { channels: ['sync-status'] },
      }),
    );
  });
}

describe('ConflictsProvider', () => {
  beforeEach(() => {
    consumerRenders = 0;
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('fetches /api/sync/conflicts on mount and exposes results', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: '2026-05-20T10:00:00.000Z',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
            {
              file: 'docs/b.md',
              detectedAt: '2026-05-20T10:01:00.000Z',
              conflict: 'merge-native',
              docName: 'docs/b',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <Probe />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    expect(conflictsFetchCount()).toBe(1);
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(screen.getByTestId('files').textContent).toBe('docs/a.md,docs/b.md');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  test('bounds the conflicts request with an abort signal', async () => {
    fetchResponse = () => new Response(JSON.stringify({ conflicts: [] }), { status: 200 });
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    render(
      <ConflictsProvider>
        <Probe />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });

    const call = fetchCalls.find((entry) => entry.url === '/api/sync/conflicts');
    expect(call).toBeDefined();
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init?.signal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  test('many consumers share ONE fetch', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <Probe />
        <DocProbe docName="docs/a" testId="one" />
        <DocProbe docName="docs/a" testId="two" />
        <DocProbe docName="docs/b" testId="three" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('one').textContent).toBe('docs/a.md');
    });
    expect(conflictsFetchCount()).toBe(1);
    expect(screen.getByTestId('two').textContent).toBe('docs/a.md');
    expect(screen.getByTestId('three').textContent).toBe('none');
  });

  test('a sync-status signal causes exactly ONE refetch and flips useDocConflict', async () => {
    let payload: { conflicts: Array<Record<string, unknown>> } = { conflicts: [] };
    fetchResponse = () => new Response(JSON.stringify(payload), { status: 200 });

    render(
      <ConflictsProvider>
        <DocProbe docName="docs/a" testId="a" />
        <DocProbe docName="docs/b" testId="b" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(conflictsFetchCount()).toBe(1);
    });
    expect(screen.getByTestId('a').textContent).toBe('none');

    payload = {
      conflicts: [
        {
          file: 'docs/a.md',
          detectedAt: 't1',
          conflict: 'merge-native',
          docName: 'docs/a',
        },
      ],
    };
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.getByTestId('a').textContent).toBe('docs/a.md');
    });
    expect(conflictsFetchCount()).toBe(2);
    expect(screen.getByTestId('b').textContent).toBe('none');

    payload = { conflicts: [] };
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.getByTestId('a').textContent).toBe('none');
    });
    expect(conflictsFetchCount()).toBe(3);
  });

  test('does NOT re-fetch on non-sync-status channels', async () => {
    fetchResponse = () => new Response(JSON.stringify({ conflicts: [] }), { status: 200 });
    render(
      <ConflictsProvider>
        <Probe />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    const initialFetchCount = conflictsFetchCount();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:documents-changed', {
          detail: { channels: ['files'] },
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conflictsFetchCount()).toBe(initialFetchCount);
  });

  test('two signals carrying an identical payload leave consumers un-re-rendered', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <RenderCountProbe />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('render-count-files').textContent).toBe('1');
    });
    const rendersAtFirstSnapshot = consumerRenders;

    signalSyncStatus();
    await waitFor(() => {
      expect(conflictsFetchCount()).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    signalSyncStatus();
    await waitFor(() => {
      expect(conflictsFetchCount()).toBe(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consumerRenders).toBe(rendersAtFirstSnapshot);
    expect(screen.getByTestId('render-count-files').textContent).toBe('1');
  });

  test('a changed payload does re-render consumers', async () => {
    let payload: { conflicts: Array<Record<string, unknown>> } = {
      conflicts: [
        {
          file: 'docs/a.md',
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: 'docs/a',
        },
      ],
    };
    fetchResponse = () => new Response(JSON.stringify(payload), { status: 200 });

    render(
      <ConflictsProvider>
        <RenderCountProbe />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('render-count-files').textContent).toBe('1');
    });
    const rendersAtFirstSnapshot = consumerRenders;

    payload = {
      conflicts: [
        {
          file: 'docs/a.md',
          detectedAt: 't1',
          conflict: 'merge-native',
          docName: 'docs/a',
        },
      ],
    };
    signalSyncStatus();

    await waitFor(() => {
      expect(consumerRenders).toBeGreaterThan(rendersAtFirstSnapshot);
    });
  });

  test('an entry whose only change is an unlisted wire field is not reused', async () => {
    let payload: { conflicts: Array<Record<string, unknown>> } = {
      conflicts: [
        {
          file: 'docs/a.md',
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: 'docs/a',
          resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
        },
      ],
    };
    fetchResponse = () => new Response(JSON.stringify(payload), { status: 200 });

    render(
      <ConflictsProvider>
        <EntryEffectProbe docName="docs/a" testId="a-effects" />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('a-effects').textContent).toBe('1');
    });

    payload = {
      conflicts: [
        {
          file: 'docs/a.md',
          detectedAt: 't0',
          conflict: 'merge-native',
          docName: 'docs/a',
          resolutionOptions: ['mine', 'delete'],
        },
      ],
    };
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.getByTestId('a-effects').textContent).toBe('2');
    });
  });

  test('an unrelated conflict appearing leaves this entry identical to entry-keyed effects', async () => {
    const docsA = {
      file: 'docs/a.md',
      detectedAt: 't0',
      conflict: 'merge-native',
      docName: 'docs/a',
    };
    let payload: { conflicts: Array<Record<string, unknown>> } = { conflicts: [docsA] };
    fetchResponse = () => new Response(JSON.stringify(payload), { status: 200 });

    render(
      <ConflictsProvider>
        <EntryEffectProbe docName="docs/a" testId="a-effects" />
        <DocProbe docName="docs/b" testId="b" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('a-effects').textContent).toBe('1');
    });

    payload = {
      conflicts: [
        docsA,
        {
          file: 'docs/b.md',
          detectedAt: 't1',
          conflict: 'reconcile',
          docName: 'docs/b',
        },
      ],
    };
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.getByTestId('b').textContent).toBe('docs/b.md');
    });
    expect(screen.getByTestId('a-effects').textContent).toBe('1');
  });

  test('useDocConflict reads as no conflict until the first snapshot lands', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <DocProbe docName="docs/a" testId="a" />
        <DocProbe docName="docs/b" testId="b" />
        <DocProbe docName={null} testId="nothing-open" />
      </ConflictsProvider>,
    );

    expect(screen.getByTestId('a').textContent).toBe('none');
    expect(screen.getByTestId('b').textContent).toBe('none');
    expect(screen.getByTestId('nothing-open').textContent).toBe('none');

    await waitFor(() => {
      expect(screen.getByTestId('a').textContent).toBe('docs/a.md');
    });
    expect(screen.getByTestId('b').textContent).toBe('none');
  });

  test('a failed first fetch reports the failure and still reads as no conflict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchResponse = () => new Response('internal', { status: 500 });

    render(
      <ConflictsProvider>
        <Probe />
        <DocProbe docName="docs/a" testId="a" />
      </ConflictsProvider>,
    );

    expect(screen.getByTestId('a').textContent).toBe('none');
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('server');
    });
    expect(screen.getByTestId('loading').textContent).toBe('no');
    expect(screen.getByTestId('a').textContent).toBe('none');
    warn.mockRestore();
  });

  test('a failure after a good snapshot keeps the doc answers it already had', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <Probe />
        <DocProbe docName="docs/a" testId="a" />
        <DocProbe docName="docs/b" testId="b" />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('a').textContent).toBe('docs/a.md');
    });

    fetchResponse = () => new Response('internal', { status: 500 });
    signalSyncStatus();

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('server');
    });
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('a').textContent).toBe('docs/a.md');
    expect(screen.getByTestId('b').textContent).toBe('none');
    warn.mockRestore();
  });

  test('a 200 whose body fails the wire schema is treated as a server error, not as clear', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchResponse = () =>
      new Response(JSON.stringify({ conflicts: [{ nonsense: true }] }), { status: 200 });

    render(
      <ConflictsProvider>
        <Probe />
        <DocProbe docName="docs/a" testId="a" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('server');
    });
    expect(screen.getByTestId('a').textContent).toBe('none');
    warn.mockRestore();
  });

  test('an unknown docName and a null docName both read as no conflict', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'docs/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: 'docs/a',
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <DocProbe docName="docs/a" testId="known" />
        <DocProbe docName="docs/never-heard-of-it" testId="unknown" />
        <DocProbe docName={null} testId="nullish" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('known').textContent).toBe('docs/a.md');
    });
    expect(screen.getByTestId('unknown').textContent).toBe('none');
    expect(screen.getByTestId('nullish').textContent).toBe('none');
  });

  test('an entry with a null docName is not indexed by doc name', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            {
              file: 'outside/a.md',
              detectedAt: 't0',
              conflict: 'merge-native',
              docName: null,
            },
          ],
        }),
        { status: 200 },
      );

    render(
      <ConflictsProvider>
        <Probe />
        <DocProbe docName="outside/a" testId="orphan" />
      </ConflictsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('1');
    });
    expect(screen.getByTestId('orphan').textContent).toBe('none');
  });

  test('classifies a thrown fetch as error: "network"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = () => Promise.reject(new Error('boom'));
    render(
      <ConflictsProvider>
        <Probe />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('network');
    });
    warn.mockRestore();
  });

  test('classifies a timed-out fetch as error: "network"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timedOut = new Error('The operation timed out.');
    timedOut.name = 'TimeoutError';
    globalThis.fetch = () => Promise.reject(timedOut);
    render(
      <ConflictsProvider>
        <Probe />
      </ConflictsProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('network');
    });
    warn.mockRestore();
  });

  test('useDocConflict throws when rendered outside the provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<DocProbe docName="docs/a" testId="loose" />)).toThrow(
      ConflictsProviderMissingError,
    );
    error.mockRestore();
  });
});
