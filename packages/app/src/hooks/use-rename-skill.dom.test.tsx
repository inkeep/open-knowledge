import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

/**
 * The rename flow busy-marks BOTH names for the tab reconciler and must
 * release them on EVERY path — a leaked mark suppresses the reconciler for
 * that skill for the rest of the session (module state only a reload clears).
 * Mirrors the sibling `use-move-skill-scope.dom.test.tsx`, which pins the same
 * always-released contract for the scope-move flow.
 */
const openTarget = vi.fn();
const closeDocument = vi.fn();
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    openTarget,
    closeDocument,
    activeDocName: '.claude/skills/old-name/SKILL',
    openTabs: ['.claude/skills/old-name/SKILL'],
  }),
}));
const beginSkillWrite = vi.fn();
const endSkillWrite = vi.fn();
vi.doMock('@/lib/documents-events', () => ({ beginSkillWrite, endSkillWrite }));
const moveSkill = vi.fn();
vi.doMock('@/lib/skills-api', () => ({ moveSkill }));
const whenSkillsListContains = vi.fn(() => Promise.resolve());
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'loading' }),
  whenSkillsListContains,
}));
vi.doMock('@/lib/skill-track-prompt-store', () => ({ requestSkillTrackPrompt: vi.fn() }));
vi.doMock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { useRenameSkill } = await import('@/components/ManagedArtifactProperties');

function resetSpies() {
  beginSkillWrite.mockClear();
  endSkillWrite.mockClear();
  openTarget.mockClear();
  whenSkillsListContains.mockClear();
  moveSkill.mockReset();
}

describe('useRenameSkill busy-mark bracketing', () => {
  test('a failed rename (ok: false) releases both marks immediately', async () => {
    resetSpies();
    moveSkill.mockResolvedValue({ ok: false, error: 'nope' });
    const { result } = renderHook(() => useRenameSkill());

    await result.current({ scope: 'project', name: 'old-name' }, 'new-name');

    expect(beginSkillWrite.mock.calls).toEqual([
      ['project', 'old-name'],
      ['project', 'new-name'],
    ]);
    expect(endSkillWrite.mock.calls).toEqual(
      expect.arrayContaining([
        ['project', 'old-name'],
        ['project', 'new-name'],
      ]),
    );
    expect(openTarget).not.toHaveBeenCalled();
  });

  test('a rejected rename releases both marks and rethrows', async () => {
    resetSpies();
    moveSkill.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useRenameSkill());

    await expect(
      result.current({ scope: 'project', name: 'old-name' }, 'new-name'),
    ).rejects.toThrow('network down');
    expect(endSkillWrite.mock.calls).toEqual(
      expect.arrayContaining([
        ['project', 'old-name'],
        ['project', 'new-name'],
      ]),
    );
  });

  test('a retarget throw after a successful rename still releases both marks', async () => {
    resetSpies();
    moveSkill.mockResolvedValue({ ok: true, committed: false, to: '.claude/skills/new-name' });
    openTarget.mockImplementation(() => {
      throw new Error('retarget boom');
    });
    const { result } = renderHook(() => useRenameSkill());

    const out = await result.current({ scope: 'project', name: 'old-name' }, 'new-name');
    expect(out.ok).toBe(true);
    // Release rides the list-confirmation waiter (mocked resolved), so flush it.
    await waitFor(() => {
      expect(endSkillWrite.mock.calls).toEqual(
        expect.arrayContaining([
          ['project', 'old-name'],
          ['project', 'new-name'],
        ]),
      );
    });
    expect(whenSkillsListContains).toHaveBeenCalledWith('project', 'new-name');
  });
});
