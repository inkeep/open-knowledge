/**
 * RTL behavioral tests for `useConflicts`.
 *
 * Pins:
 *   - Initial fetch hits `/api/sync/conflicts` on mount; `loading` flips to
 *     `false` once the response (success OR failure) lands.
 *   - CC1 `sync-status` channel signal triggers a re-fetch (re-invalidation).
 *   - Non-`sync-status` channels DO NOT trigger a re-fetch — the hook is
 *     scoped to its own invalidation source.
 *   - Network / server failures populate `error` without throwing.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useConflicts } from './use-conflicts';

interface CapturedFetch {
  url: string;
}

let fetchCalls: CapturedFetch[] = [];
let fetchResponse: () => Response = () =>
  new Response(JSON.stringify({ conflicts: [] }), { status: 200 });

function installFetchStub() {
  fetchCalls = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url });
    return Promise.resolve(fetchResponse());
  };
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

describe('useConflicts', () => {
  beforeEach(() => {
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
  });

  test('fetches /api/sync/conflicts on mount and exposes results', async () => {
    fetchResponse = () =>
      new Response(
        JSON.stringify({
          conflicts: [
            { file: 'docs/a.md', detectedAt: '2026-05-20T10:00:00.000Z' },
            { file: 'docs/b.md', detectedAt: '2026-05-20T10:01:00.000Z' },
          ],
        }),
        { status: 200 },
      );

    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    expect(fetchCalls.some((c) => c.url === '/api/sync/conflicts')).toBe(true);
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(screen.getByTestId('files').textContent).toBe('docs/a.md,docs/b.md');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  test('re-fetches when a CC1 sync-status signal fires', async () => {
    let payload = { conflicts: [{ file: 'docs/a.md', detectedAt: 't0' }] };
    fetchResponse = () => new Response(JSON.stringify(payload), { status: 200 });

    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('1');
    });

    payload = {
      conflicts: [
        { file: 'docs/a.md', detectedAt: 't0' },
        { file: 'docs/c.md', detectedAt: 't1' },
      ],
    };

    act(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:documents-changed', {
          detail: { channels: ['sync-status'] },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('count').textContent).toBe('2');
    });
  });

  test('does NOT re-fetch on non-sync-status channels', async () => {
    fetchResponse = () => new Response(JSON.stringify({ conflicts: [] }), { status: 200 });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('no');
    });
    const initialFetchCount = fetchCalls.length;

    act(() => {
      window.dispatchEvent(
        new CustomEvent('open-knowledge:documents-changed', {
          detail: { channels: ['files'] },
        }),
      );
    });

    // Brief tick to allow any (incorrect) re-fetch to enqueue.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalls.length).toBe(initialFetchCount);
  });

  test('classifies a server (HTTP non-2xx) failure as error: "server"', async () => {
    fetchResponse = () => new Response('internal', { status: 500 });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('server');
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  test('classifies a thrown fetch (network) as error: "network"', async () => {
    globalThis.fetch = () => Promise.reject(new Error('boom'));
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('network');
    });
  });
});
