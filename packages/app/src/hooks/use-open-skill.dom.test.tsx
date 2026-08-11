import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * The shared opener is where every "open a skill" surface converges, so it owns
 * the gitignored-bundle gate. Two rules, and both have bitten:
 *   - a gitignored bundle has no doc to open, so raise the explainer instead of
 *     handing the user an empty tab with no reason;
 *   - EXCEPT a managed built-in, which OK ships read-only and a repo that
 *     ignores it means it — offering to git-track one is an offer the user must
 *     not be given.
 */
const openTarget = vi.fn();
const setSkillsSidebar = vi.fn();
const requestSkillTrackPrompt = vi.fn();

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ openTarget, setSkillsSidebar }),
}));
vi.doMock('@/lib/skill-track-prompt-store', () => ({ requestSkillTrackPrompt }));
vi.doMock('@/lib/skills-api', () => ({ listSkills: vi.fn() }));

const entry = {
  scope: 'project' as const,
  name: 'hidden',
  path: '.claude/skills/hidden/SKILL.md',
  installed: true,
  hosts: [],
};
let skills: unknown[] = [];
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'ready', data: skills }) }));

const { useOpenSkill } = await import('./use-open-skill');

afterEach(() => {
  openTarget.mockClear();
  requestSkillTrackPrompt.mockClear();
});

describe('useOpenSkill gitignored gate', () => {
  test('a gitignored skill raises the explainer instead of an empty tab', () => {
    skills = [{ ...entry, ignored: true }];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    expect(requestSkillTrackPrompt).toHaveBeenCalledWith({ scope: 'project', name: 'hidden' });
    expect(openTarget).not.toHaveBeenCalled();
  });

  test('a managed built-in is never offered the git-track fix', () => {
    // Read-only and deliberately excluded: it opens through its own read-only
    // preview surface, and must not be routed into "add a .gitignore rule".
    skills = [{ ...entry, ignored: true, managed: true }];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    expect(requestSkillTrackPrompt).not.toHaveBeenCalled();
    expect(openTarget).toHaveBeenCalled();
  });

  test('an ordinary skill opens, untouched by the gate', () => {
    skills = [entry];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    expect(requestSkillTrackPrompt).not.toHaveBeenCalled();
    expect(openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ docName: '.claude/skills/hidden/SKILL' }),
      undefined,
    );
  });
});
