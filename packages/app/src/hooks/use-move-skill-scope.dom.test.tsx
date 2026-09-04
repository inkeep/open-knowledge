import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const retarget = vi.fn();

vi.doMock('@/components/ManagedArtifactProperties', () => ({
  useManagedArtifactRetarget: () => retarget,
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    openTabs: ['.claude/skills/improve-codebase-architecture/SKILL'],
  }),
}));
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'loading' }) }));
vi.doMock('@/lib/skill-scope', () => ({
  useSkillScopeLabels: () => ({ project: 'Project', global: 'Global' }),
}));
const beginSkillWrite = vi.fn();
const endSkillWrite = vi.fn();
vi.doMock('@/lib/documents-events', () => ({
  beginSkillWrite,
  endSkillWrite,
  beginOptimisticSkillMove: vi.fn(),
  endOptimisticSkillMove: vi.fn(),
}));
vi.doMock('@/lib/skills-api', () => ({
  moveSkillScope: vi.fn(async () => ({ ok: true })),
}));

const { useMoveSkillScope } = await import('./use-move-skill-scope');

describe('useMoveSkillScope retarget source', () => {
  test('repoints the REAL in-place doc when the skills list lookup misses', async () => {
    const { result } = renderHook(() => useMoveSkillScope());

    await result.current({ scope: 'project', name: 'improve-codebase-architecture' }, 'global');

    expect(retarget).toHaveBeenCalledTimes(1);
    const [fromDoc, toDoc] = retarget.mock.calls[0] as [string, string];
    expect(fromDoc).toBe('.claude/skills/improve-codebase-architecture/SKILL');
    expect(fromDoc).not.toContain('.ok/skills');
    expect(toDoc).toBe('__skill__/global/improve-codebase-architecture');
  });

  test('refuses to retarget when no open tab matches the skill', async () => {
    retarget.mockClear();
    const { result } = renderHook(() => useMoveSkillScope());

    await result.current({ scope: 'project', name: 'not-an-open-tab' }, 'global');

    expect(retarget).not.toHaveBeenCalled();
  });
});

describe('the write flag is always released', () => {
  test('a FAILED move releases it too', async () => {
    const api = await import('@/lib/skills-api');
    vi.mocked(api.moveSkillScope).mockResolvedValueOnce({ ok: false, error: 'nope' });
    const { result } = renderHook(() => useMoveSkillScope());

    const moved = await result.current(
      { scope: 'project', name: 'improve-codebase-architecture' },
      'global',
    );

    expect(moved).toBe(false);
    expect(endSkillWrite).toHaveBeenCalledWith('project', 'improve-codebase-architecture');
  });

  test('a throwing retarget still ends the write', async () => {
    retarget.mockImplementationOnce(() => {
      throw new Error('retarget blew up');
    });
    const { result } = renderHook(() => useMoveSkillScope());

    const moved = await result.current(
      { scope: 'project', name: 'improve-codebase-architecture' },
      'global',
    );

    expect(moved).toBe(true);
    expect(beginSkillWrite).toHaveBeenCalledWith('project', 'improve-codebase-architecture');
    expect(endSkillWrite).toHaveBeenCalledWith('project', 'improve-codebase-architecture');
  });
});
