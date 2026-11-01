import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readManagedHashHistoryEntry } from '@/lib/doc-hash';

const openTarget = vi.fn();
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ openTarget }),
}));

const editExternalSkill = vi.fn();
vi.doMock('@/lib/skills-api', () => ({ editExternalSkill }));

const { useOpenSkillForEdit } = await import('./use-open-skill-for-edit');

afterEach(() => {
  openTarget.mockClear();
  editExternalSkill.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('useOpenSkillForEdit navigation disposition', () => {
  test('an active-tab replacement keeps its preview disposition in the hash metadata', async () => {
    window.history.replaceState(null, '', '/app#/old-skill');
    editExternalSkill.mockResolvedValue({ ok: true, docName: 'external-skill/SKILL' });
    const { result } = renderHook(() => useOpenSkillForEdit());

    await expect(
      result.current('external-skill', '/workspace', { replaceActive: true }),
    ).resolves.toEqual({ ok: true, docName: 'external-skill/SKILL' });

    expect(openTarget).toHaveBeenCalledWith(
      {
        kind: 'doc',
        target: 'external-skill/SKILL',
        docName: 'external-skill/SKILL',
      },
      { tabBehavior: 'replace-active', disposition: 'preview' },
    );
    expect(readManagedHashHistoryEntry(window.history.state)).toEqual(
      expect.objectContaining({ disposition: 'preview' }),
    );
  });
});
