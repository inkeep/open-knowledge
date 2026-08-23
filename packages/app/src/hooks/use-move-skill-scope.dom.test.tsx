import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * A scope move must repoint any open tab at the skill's REAL doc. An in-place
 * project skill is open at its content path (`.claude/skills/<name>/SKILL`), so
 * falling back to the store shape (`.ok/skills/<name>/SKILL`) matches no tab:
 * the retarget silently no-ops and the tab is left on a path the move deletes,
 * which is what stranded it on "Couldn't load document".
 *
 * The list lookup misses ROUTINELY here — `beginOptimisticSkillMove` drops the
 * source row before this runs — so the fallback is the common path, not the edge.
 */
const retarget = vi.fn();

vi.doMock('@/components/ManagedArtifactProperties', () => ({
  useManagedArtifactRetarget: () => retarget,
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    // The real in-place project doc is open; the store-shaped name is not.
    openTabs: ['.claude/skills/improve-codebase-architecture/SKILL'],
  }),
}));
// Deliberately NOT ready: reproduces the lookup miss.
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
    // The bug: a minted store path matches no open tab, so the retarget no-ops.
    expect(fromDoc).not.toContain('.ok/skills');
    expect(toDoc).toBe('__skill__/global/improve-codebase-architecture');
    // And the surface stays on Skills rather than following into Files.
  });

  test('refuses to retarget when no open tab matches the skill', async () => {
    // The complement of the case above, and the actual safety net: with no
    // resolvable source we must skip rather than fall back to a guessed name.
    // Dropping this guard would silently reintroduce the store-shaped phantom.
    retarget.mockClear();
    const { result } = renderHook(() => useMoveSkillScope());

    await result.current({ scope: 'project', name: 'not-an-open-tab' }, 'global');

    expect(retarget).not.toHaveBeenCalled();
    // The move still succeeded, so the surface must still stay on Skills.
  });
});

describe('the write flag is always released', () => {
  test('a FAILED move releases it too', async () => {
    // The flag suppresses the tab reconciler while set, so leaking it on the
    // error path disables tab repair for the session just as surely as leaking
    // it on success — and a failed move is exactly when the user retries.
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
    // The flag is module state that only a page reload clears, and it SUPPRESSES
    // the tab reconciler for this skill while set. Leaking it disables the one
    // thing that repairs a tab left on the pre-move doc: the tab never repoints,
    // the toolbar keeps deriving its level from the stale doc name, and the
    // skill stays stuck until the user reloads the window.
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
    // The move succeeded, so the surface belongs on Skills even though the tab
    // repoint threw — otherwise a working move dumps the user into Files.
  });
});
