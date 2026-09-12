import type { SemanticIndexStatus } from '@inkeep/open-knowledge-core';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSemanticSearchStatus } from './use-semantic-search-status';

const STATUS: SemanticIndexStatus = {
  enabled: true,
  keyPresent: false,
  keyNotRequired: true,
  keySource: null,
  keyHint: null,
  ready: false,
  capable: false,
  embedded: 0,
  total: 3,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useSemanticSearchStatus', () => {
  test('accepts a schema-valid status response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(STATUS)));

    const { result } = renderHook(() => useSemanticSearchStatus());

    await waitFor(() => expect(result.current).toMatchObject({ status: STATUS, stale: false }));
  });

  test('clears an invalid status response without arming a transport retry', async () => {
    let retry: (() => void) | null = null;
    let valid = true;
    const nativeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout) => {
      if (timeout === 2500) {
        retry = handler as () => void;
        return 1;
      }
      return nativeSetTimeout(handler, timeout);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(valid ? STATUS : { enabled: true }))),
    );
    const { result } = renderHook(() => useSemanticSearchStatus());
    await waitFor(() => expect(result.current.status).toEqual(STATUS));

    valid = false;
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current).toMatchObject({ status: null, stale: false }));
    expect(console.warn).toHaveBeenCalledWith(
      '[semantic-status] probe returned an invalid payload',
    );
    expect(retry).toBeNull();
  });

  test('retains the last good status and retries until transport recovers', async () => {
    const retries: Array<{ run: () => void; delay: number }> = [];
    let offline = false;
    const nativeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout) => {
      if (typeof timeout === 'number' && timeout >= 2500) {
        retries.push({ run: handler as () => void, delay: timeout });
        return 1;
      }
      return nativeSetTimeout(handler, timeout);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      if (offline) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify(STATUS)));
    });
    const { result } = renderHook(() => useSemanticSearchStatus());
    await waitFor(() => expect(result.current.status).toEqual(STATUS));

    offline = true;
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current).toMatchObject({ status: STATUS, stale: true }));
    expect(console.warn).toHaveBeenCalledWith('[semantic-status] probe failed', expect.any(Error));
    expect(retries.map(({ delay }) => delay)).toEqual([2500]);

    act(() => retries[0]?.run());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(retries.map(({ delay }) => delay)).toEqual([2500, 5000]));

    offline = false;
    act(() => retries[1]?.run());

    await waitFor(() => expect(result.current).toMatchObject({ status: STATUS, stale: false }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(retries).toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a concurrent refresh cannot end the transport retry chain', async () => {
    const retries: Array<{ run: () => void; delay: number }> = [];
    const nativeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout) => {
      if (typeof timeout === 'number' && timeout >= 2500) {
        retries.push({ run: handler as () => void, delay: timeout });
        return 1;
      }
      return nativeSetTimeout(handler, timeout);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryProbe = Promise.withResolvers<Response>();
    const refreshProbe = Promise.withResolvers<Response>();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => retryProbe.promise)
      .mockImplementationOnce(() => refreshProbe.promise);
    const { result } = renderHook(() => useSemanticSearchStatus());

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(retries.map(({ delay }) => delay)).toEqual([2500]);

    act(() => retries[0]?.run());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      retryProbe.reject(new Error('retry offline'));
      refreshProbe.reject(new Error('refresh offline'));
      await Promise.allSettled([retryProbe.promise, refreshProbe.promise]);
    });

    await waitFor(() => expect(retries.map(({ delay }) => delay)).toEqual([2500, 2500]));
  });

  test('an older probe cannot overwrite a newer response', async () => {
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useSemanticSearchStatus());

    act(() => result.current.refresh());
    await act(async () => {
      second.resolve(new Response(JSON.stringify({ ...STATUS, embedded: 2 })));
      await second.promise;
    });
    await waitFor(() => expect(result.current.status?.embedded).toBe(2));

    await act(async () => {
      first.resolve(new Response(JSON.stringify(STATUS)));
      await first.promise;
    });
    expect(result.current.status?.embedded).toBe(2);
  });
});
