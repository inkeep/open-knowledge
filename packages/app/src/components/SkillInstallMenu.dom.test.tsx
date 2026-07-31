import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SkillActions } from '@/components/skill-actions';
import { __resetSkillOverlaysForTests } from '@/lib/skill-install-overlay-store';
import { useSkillHostToggles } from './SkillInstallMenu';

describe('useSkillHostToggles', () => {
  afterEach(() => {
    cleanup();
    __resetSkillOverlaysForTests();
    vi.useRealTimers();
  });

  test('flushes a pending target change when its menu unmounts', () => {
    vi.useFakeTimers();
    const install = vi.fn().mockResolvedValue({
      ok: true,
      hosts: ['codex'],
      scripts: false,
      warnings: [],
      warningCodes: [],
    });
    const skill = {
      name: 'example',
      scope: 'project',
      hosts: [],
      installed: false,
    } as unknown as SkillsListEntry;
    const actions = {
      install,
      installingName: null,
    } as unknown as SkillActions;
    const { result, unmount } = renderHook(() => useSkillHostToggles(skill, actions));

    act(() => result.current.toggleEditor('codex', true));
    expect(install).not.toHaveBeenCalled();

    unmount();

    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(skill, ['codex']);
  });

  test('a toggle in one surface is visible in every other surface for the same skill', () => {
    vi.useFakeTimers();
    const install = vi.fn().mockResolvedValue({
      ok: true,
      hosts: ['codex'],
      scripts: false,
      warnings: [],
      warningCodes: [],
    });
    const skill = {
      name: 'shared',
      scope: 'project',
      hosts: [],
      installed: false,
    } as unknown as SkillsListEntry;
    const actions = { install, installingName: null } as unknown as SkillActions;
    // The toolbar pill and the sidebar menu mount the hook independently — the
    // pill used to keep reading "not installed" while the menu already showed
    // the checkmark.
    const pill = renderHook(() => useSkillHostToggles(skill, actions));
    const menu = renderHook(() => useSkillHostToggles(skill, actions));

    act(() => menu.result.current.toggleEditor('codex', true));

    expect(menu.result.current.installed).toBe(true);
    expect(pill.result.current.installed).toBe(true);
    expect(pill.result.current.hostSet.has('codex')).toBe(true);

    pill.unmount();
    menu.unmount();
  });

  test('a different skill keeps its own overlay', () => {
    vi.useFakeTimers();
    const install = vi.fn().mockResolvedValue({
      ok: true,
      hosts: ['codex'],
      scripts: false,
      warnings: [],
      warningCodes: [],
    });
    const actions = { install, installingName: null } as unknown as SkillActions;
    const one = { name: 'one', scope: 'project', hosts: [], installed: false };
    const two = { name: 'two', scope: 'project', hosts: [], installed: false };
    const a = renderHook(() => useSkillHostToggles(one as unknown as SkillsListEntry, actions));
    const b = renderHook(() => useSkillHostToggles(two as unknown as SkillsListEntry, actions));

    act(() => a.result.current.toggleEditor('codex', true));

    expect(a.result.current.installed).toBe(true);
    expect(b.result.current.installed).toBe(false);

    a.unmount();
    b.unmount();
  });
});
