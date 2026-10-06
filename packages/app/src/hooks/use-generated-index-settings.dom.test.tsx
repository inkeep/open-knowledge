import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useGeneratedIndexSettings } from './use-generated-index-settings.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rejectedUpdates = [
  { reason: 'git-conflict', gitState: 'conflict', activeWhenEnabled: false },
  { reason: 'git-unavailable', gitState: 'unavailable', activeWhenEnabled: false },
  { reason: 'config-write', gitState: 'ready', activeWhenEnabled: true },
];

describe('useGeneratedIndexSettings', () => {
  test.each(rejectedUpdates)(
    'retains $reason after a status refresh until another update succeeds',
    async ({ reason, gitState }) => {
      const snapshot = { enabled: false, active: false, git: { state: gitState } };
      const rejection = { ...snapshot, applied: false, reason };
      const accepted = { ...snapshot, applied: true };
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json(snapshot))
        .mockResolvedValueOnce(Response.json(rejection))
        .mockResolvedValueOnce(Response.json(snapshot))
        .mockResolvedValueOnce(Response.json(accepted));

      const { result } = renderHook(() => useGeneratedIndexSettings());
      await waitFor(() => expect(result.current.status).toEqual(snapshot));

      await act(async () => {
        expect(await result.current.setEnabled(true)).toBe(false);
      });
      expect(result.current.issue).toBe(reason);

      await act(async () => result.current.refresh());
      expect(result.current.status).toEqual(snapshot);
      expect(result.current.issue).toBe(reason);
      expect(result.current.requestedEnabled).toBe(true);

      await act(async () => {
        expect(await result.current.setEnabled(false)).toBe(true);
      });
      expect(result.current.issue).toBeNull();
    },
  );

  test.each(rejectedUpdates)(
    'drops a rejected enable with $reason once a status read shows generation on',
    async ({ reason, gitState, activeWhenEnabled }) => {
      const off = { enabled: false, active: false, git: { state: gitState } };
      const on = { enabled: true, active: activeWhenEnabled, git: { state: gitState } };
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json(off))
        .mockResolvedValueOnce(Response.json({ ...off, applied: false, reason }))
        .mockResolvedValueOnce(Response.json(on));

      const { result } = renderHook(() => useGeneratedIndexSettings());
      await waitFor(() => expect(result.current.status).toEqual(off));

      await act(async () => {
        expect(await result.current.setEnabled(true)).toBe(false);
      });
      expect(result.current.issue).toBe(reason);

      await act(async () => result.current.refresh());
      expect(result.current.status).toEqual(on);
      expect(result.current.issue).toBeNull();
    },
  );

  test.each(rejectedUpdates)(
    'keeps a rejected disable with $reason until a status read shows generation off',
    async ({ reason, gitState, activeWhenEnabled }) => {
      const on = { enabled: true, active: activeWhenEnabled, git: { state: gitState } };
      const off = { enabled: false, active: false, git: { state: gitState } };
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json(on))
        .mockResolvedValueOnce(Response.json({ ...on, applied: false, reason }))
        .mockResolvedValueOnce(Response.json(on))
        .mockResolvedValueOnce(Response.json(off));

      const { result } = renderHook(() => useGeneratedIndexSettings());
      await waitFor(() => expect(result.current.status).toEqual(on));

      await act(async () => {
        expect(await result.current.setEnabled(false)).toBe(false);
      });
      expect(result.current.issue).toBe(reason);

      await act(async () => result.current.refresh());
      expect(result.current.status).toEqual(on);
      expect(result.current.issue).toBe(reason);
      expect(result.current.requestedEnabled).toBe(false);

      await act(async () => result.current.refresh());
      expect(result.current.status).toEqual(off);
      expect(result.current.issue).toBeNull();
    },
  );

  test('clears a refresh connection failure when status reads recover', async () => {
    const snapshot = { enabled: false, active: false, git: { state: 'ready' } };
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce(Response.json(snapshot));

    const { result } = renderHook(() => useGeneratedIndexSettings());
    await waitFor(() => expect(result.current.issue).toBe('connection'));

    await act(async () => result.current.refresh());
    expect(result.current.status).toEqual(snapshot);
    expect(result.current.issue).toBeNull();
  });

  test('restores rejected update feedback after a status connection failure recovers', async () => {
    const snapshot = { enabled: false, active: false, git: { state: 'conflict' } };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ ...snapshot, applied: false, reason: 'git-conflict' }))
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce(Response.json(snapshot));

    const { result } = renderHook(() => useGeneratedIndexSettings());
    await waitFor(() => expect(result.current.status).toEqual(snapshot));
    await act(async () => result.current.setEnabled(true));

    await act(async () => result.current.refresh());
    expect(result.current.issue).toBe('connection');

    await act(async () => result.current.refresh());
    expect(result.current.status).toEqual(snapshot);
    expect(result.current.issue).toBe('git-conflict');
    expect(result.current.requestedEnabled).toBe(true);
  });

  test('clears an update connection failure when a status read recovers', async () => {
    const snapshot = { enabled: false, active: false, git: { state: 'ready' } };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce(Response.json(snapshot));

    const { result } = renderHook(() => useGeneratedIndexSettings());
    await waitFor(() => expect(result.current.status).toEqual(snapshot));
    await act(async () => result.current.setEnabled(true));
    expect(result.current.issue).toBe('connection');

    await act(async () => result.current.refresh());
    expect(result.current.status).toEqual(snapshot);
    expect(result.current.issue).toBeNull();
  });

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

  test('keeps a disable that could not reach the server through a failed status read until a read succeeds', async () => {
    const on = { enabled: true, active: true, git: { state: 'ready' } };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(on))
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockRejectedValueOnce(new Error('server unavailable'))
      .mockResolvedValueOnce(Response.json(on));

    const { result } = renderHook(() => useGeneratedIndexSettings());
    await waitFor(() => expect(result.current.status).toEqual(on));

    await act(async () => {
      expect(await result.current.setEnabled(false)).toBe(false);
    });
    expect(result.current.issue).toBe('connection');
    expect(result.current.requestedEnabled).toBe(false);

    await act(async () => result.current.refresh());
    expect(result.current.status).toEqual(on);
    expect(result.current.issue).toBe('connection');
    expect(result.current.requestedEnabled).toBe(false);

    await act(async () => result.current.refresh());
    expect(result.current.status).toEqual(on);
    expect(result.current.issue).toBeNull();
    expect(result.current.requestedEnabled).toBeNull();
  });
});
