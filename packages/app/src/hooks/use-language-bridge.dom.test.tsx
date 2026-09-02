import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useLanguageBridge } from './use-language-bridge';

function makeBridge(): { bridge: OkDesktopBridge; sent: string[] } {
  const sent: string[] = [];
  const setLanguagePreference = vi.fn(async (preference: string) => {
    sent.push(preference);
    return { ok: true } as const;
  });
  return { bridge: { setLanguagePreference } as unknown as OkDesktopBridge, sent };
}

describe('useLanguageBridge', () => {
  test('pushes the system sentinel unresolved', async () => {
    const { bridge, sent } = makeBridge();
    renderHook(() => useLanguageBridge(bridge, 'system', true));
    await waitFor(() => expect(sent).toEqual(['system']));
  });

  test('pushes an absent preference as the sentinel, not as a resolved locale', async () => {
    const { bridge, sent } = makeBridge();
    renderHook(() => useLanguageBridge(bridge, undefined, true));
    await waitFor(() => expect(sent).toEqual(['system']));
  });

  test('pushes an explicit choice verbatim', async () => {
    const { bridge, sent } = makeBridge();
    renderHook(() => useLanguageBridge(bridge, 'zh-Hant', true));
    await waitFor(() => expect(sent).toEqual(['zh-Hant']));
  });

  test('re-pushes when the preference changes', async () => {
    const { bridge, sent } = makeBridge();
    const { rerender } = renderHook(
      ({ preference }: { preference: 'system' | 'es' }) =>
        useLanguageBridge(bridge, preference, true),
      { initialProps: { preference: 'system' as const } },
    );
    await waitFor(() => expect(sent).toEqual(['system']));
    rerender({ preference: 'es' });
    await waitFor(() => expect(sent).toEqual(['system', 'es']));
  });

  test('stays quiet until the user layer has synced', async () => {
    const { bridge, sent } = makeBridge();
    const { rerender } = renderHook(
      ({ synced }: { synced: boolean }) => useLanguageBridge(bridge, 'es', synced),
      { initialProps: { synced: false } },
    );
    expect(sent).toEqual([]);
    rerender({ synced: true });
    await waitFor(() => expect(sent).toEqual(['es']));
  });

  test('no-ops in the browser build, where there is no bridge', () => {
    expect(() => renderHook(() => useLanguageBridge(undefined, 'es', true))).not.toThrow();
  });

  test('no-ops against a bridge that predates the method rather than crashing the shell', () => {
    const olderBridge = { project: {} } as unknown as OkDesktopBridge;
    expect(() => renderHook(() => useLanguageBridge(olderBridge, 'es', true))).not.toThrow();
  });

  test('a rejected push is swallowed rather than escaping the effect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = {
      setLanguagePreference: vi.fn(async () => {
        throw new Error('main is gone');
      }),
    } as unknown as OkDesktopBridge;
    renderHook(() => useLanguageBridge(bridge, 'es', true));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0]?.[0])).toContain('language-preference-push-failed');
    warn.mockRestore();
  });
});
