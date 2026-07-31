import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const importSkill = vi.fn();
const installSkill = vi.fn();
const placeSkill = vi.fn();

vi.doMock('@/lib/skills-api', () => ({
  importSkill,
  installSkill,
  placeSkill,
}));

const { useExplorePreviewInstall } = await import('./use-explore-preview-install');

describe('useExplorePreviewInstall', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('serializes rapid target changes and finishes with the latest intended set', async () => {
    let resolveFirstInstall:
      | ((value: {
          ok: true;
          hosts: string[];
          scripts: false;
          warnings: [];
          warningCodes: [];
        }) => void)
      | undefined;
    importSkill.mockResolvedValue({ ok: true, name: 'example' });
    installSkill
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstInstall = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        hosts: ['claude', 'codex'],
        scripts: false,
        warnings: [],
        warningCodes: [],
      });

    const { result } = renderHook(() =>
      useExplorePreviewInstall({
        source: 'owner/repo',
        name: 'example',
        initialScope: 'project',
      }),
    );

    act(() => {
      result.current.toggles.toggleEditor('claude', true);
      result.current.toggles.toggleEditor('codex', true);
    });

    await waitFor(() => expect(installSkill).toHaveBeenCalledTimes(1));
    expect(importSkill).toHaveBeenCalledTimes(1);
    expect(installSkill.mock.calls[0]?.[0].targets).toEqual(['claude']);

    await act(async () => {
      resolveFirstInstall?.({
        ok: true,
        hosts: ['claude'],
        scripts: false,
        warnings: [],
        warningCodes: [],
      });
    });

    await waitFor(() => expect(installSkill).toHaveBeenCalledTimes(2));
    expect(installSkill.mock.calls[1]?.[0].targets).toEqual(['claude', 'codex']);
    await waitFor(() => expect([...result.current.toggles.hostSet]).toEqual(['claude', 'codex']));
  });

  test('imports once when multiple targets change before acquisition finishes', async () => {
    let resolveImport: ((value: { ok: true; name: string }) => void) | undefined;
    importSkill.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    installSkill.mockResolvedValue({
      ok: true,
      hosts: ['claude', 'cursor'],
      scripts: false,
      warnings: [],
      warningCodes: [],
    });

    const { result } = renderHook(() =>
      useExplorePreviewInstall({
        source: 'owner/repo',
        name: 'example',
        initialScope: 'global',
      }),
    );

    act(() => {
      result.current.toggles.toggleEditor('claude', true);
      result.current.toggles.toggleEditor('cursor', true);
    });
    expect(importSkill).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveImport?.({ ok: true, name: 'example' });
    });

    await waitFor(() =>
      expect(installSkill).toHaveBeenLastCalledWith(
        expect.objectContaining({
          scope: 'global',
          targets: ['claude', 'cursor'],
        }),
      ),
    );
  });

  test('does not report the agents hub as installed when placement fails', async () => {
    importSkill.mockResolvedValue({ ok: true, name: 'example' });
    placeSkill.mockResolvedValue({ ok: false, error: 'destination unavailable' });

    const { result } = renderHook(() =>
      useExplorePreviewInstall({
        source: 'owner/repo',
        name: 'example',
        initialScope: 'project',
      }),
    );

    act(() => result.current.toggles.toggleEditor('agents', true));

    await waitFor(() => expect(placeSkill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.toggles.installing).toBe(false));
    expect(result.current.toggles.hostSet.has('agents')).toBe(false);
  });
});
