import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useGeneratedIndexSettings } from './use-generated-index-settings.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useGeneratedIndexSettings', () => {
  test('surfaces a refresh failure while retaining the last known status', async () => {
    const activeStatus = {
      enabled: true,
      active: true,
      git: { state: 'ready', ownership: 'open-knowledge' },
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(activeStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockRejectedValueOnce(new Error('server unavailable'));

    const { result } = renderHook(() => useGeneratedIndexSettings());
    await waitFor(() => expect(result.current.status?.active).toBe(true));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.issue).toBe('connection'));
    expect(result.current.status).toEqual(activeStatus);
  });
});
