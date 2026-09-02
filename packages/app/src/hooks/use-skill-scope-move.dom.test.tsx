import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const moveSkillScope = vi.fn(async () => ({ ok: true as const, skippedBinaryFiles: [] }));
const retarget = vi.fn(() => {});

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ openTabs: [] }),
}));
vi.doMock('@/lib/skills-api', () => ({ moveSkillScope }));
vi.doMock('@/components/ManagedArtifactProperties', () => ({
  useManagedArtifactRetarget: () => retarget,
}));
vi.doMock('@/lib/documents-events', () => ({
  beginSkillWrite: vi.fn(),
  endSkillWrite: vi.fn(),
  beginOptimisticSkillMove: () => {},
  endOptimisticSkillMove: () => {},
  applyOptimisticSkillMoves: (skills: unknown) => skills,
  subscribeToSkillsChanged: () => () => {},
}));
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({ status: 'idle' }),
}));
vi.doMock('@/lib/skill-scope', () => ({
  useSkillScopeLabels: () => ({ project: 'Project', global: 'Global', user: 'Personal' }),
  SKILL_SCOPE_ORDER: ['project', 'global'],
}));
vi.doMock('@/lib/managed-artifact-doc-name', () => ({
  skillLiveDocName: (scope: string, name: string) => `${scope}/${name}`,
  skillEntryLiveDocName: (entry: { scope: string; name: string }) => `${entry.scope}/${entry.name}`,
}));

const { useSkillScopeMove } = await import('./use-skill-scope-move');

function Harness() {
  const move = useSkillScopeMove({ scope: 'project', name: 'foo', docName: 'project/foo' });
  return (
    <>
      <button type="button" onClick={() => move.requestMove('global')}>
        pick-global
      </button>
      {move.dialog}
    </>
  );
}

describe('useSkillScopeMove — confirm before move', () => {
  test('picking a level stages a confirm dialog and does not relocate until confirmed', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText('pick-global'));
    expect(moveSkillScope).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId('skill-scope-move-confirm');

    await user.click(confirm);
    await waitFor(() => expect(moveSkillScope).toHaveBeenCalledTimes(1));
    expect(moveSkillScope).toHaveBeenCalledWith({
      name: 'foo',
      fromScope: 'project',
      toScope: 'global',
    });
  });
});
