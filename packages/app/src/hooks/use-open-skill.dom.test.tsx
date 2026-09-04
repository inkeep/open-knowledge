import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const openTarget = vi.fn();
const requestSkillTrackPrompt = vi.fn();
const listSkills = vi.fn();

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ openTarget }),
}));
vi.doMock('@/lib/skill-track-prompt-store', () => ({ requestSkillTrackPrompt }));
vi.doMock('@/lib/skills-api', () => ({ listSkills }));

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
  listSkills.mockReset();
});

describe('useOpenSkill gitignored gate', () => {
  test('a gitignored skill raises the explainer instead of an empty tab', async () => {
    skills = [{ ...entry, ignored: true }];
    listSkills.mockResolvedValue({ ok: true, skills: [{ ...entry, ignored: true }] });
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    await vi.waitFor(() => {
      expect(requestSkillTrackPrompt).toHaveBeenCalledWith({ scope: 'project', name: 'hidden' });
    });
    expect(openTarget).not.toHaveBeenCalled();
  });

  test('a STALE ignored flag re-verifies and opens instead of stranding', async () => {
    skills = [{ ...entry, ignored: true }];
    listSkills.mockResolvedValue({ ok: true, skills: [entry] });
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    await vi.waitFor(() => {
      expect(openTarget).toHaveBeenCalledWith(
        expect.objectContaining({ docName: '.claude/skills/hidden/SKILL' }),
        undefined,
      );
    });
    expect(requestSkillTrackPrompt).not.toHaveBeenCalled();
  });

  test('a managed built-in is never offered the git-track fix', () => {
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

describe('useOpenSkill symlinked-bundle routing', () => {
  test('a symlinked skill opens its read-only linked preview, not the source doc', () => {
    window.location.hash = '';
    skills = [
      {
        ...entry,
        name: 'adding-env-variables',
        path: '.agents/skills/adding-env-variables/SKILL.md',
        canonicalPath: 'public/agents/plugins/agents/skills/adding-env-variables/SKILL.md',
        absolutePath: '/repo/public/agents/plugins/agents/skills/adding-env-variables/SKILL.md',
      },
    ];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'adding-env-variables');

    expect(openTarget).not.toHaveBeenCalled();
    const hash = decodeURIComponent(window.location.hash);
    expect(hash.startsWith('#/__skill-preview__/linked/')).toBe(true);
    expect(hash).toContain('/repo/public/agents/plugins/agents/skills/adding-env-variables');
    expect(hash).not.toContain('SKILL.md');
  });

  test('an ordinary in-place skill still opens its live doc', () => {
    window.location.hash = '';
    skills = [{ ...entry, absolutePath: '/repo/.claude/skills/hidden/SKILL.md' }];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    expect(openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ docName: '.claude/skills/hidden/SKILL' }),
      undefined,
    );
  });

  test('a managed built-in opens its read-only builtin preview, never the live doc', () => {
    window.location.hash = '';
    skills = [
      {
        ...entry,
        managed: true,
        canonicalPath: 'somewhere/else/SKILL.md',
        absolutePath: '/abs/somewhere/else/SKILL.md',
      },
    ];
    const { result } = renderHook(() => useOpenSkill());
    result.current('project', 'hidden');

    const hash = decodeURIComponent(window.location.hash);
    expect(hash).toContain('/builtin/');
    expect(hash).toContain('/abs/somewhere/else');
    expect(hash).not.toContain('/linked/');
    expect(openTarget).not.toHaveBeenCalled();
  });
});
