/**
 * Regression test for the confirm-before-move safety gate in useSkillScopeMove.
 * Moving a skill's level relocates its files on disk and re-installs it at the
 * new scope, so picking a level must STAGE a confirm dialog and only relocate on
 * an explicit confirm — never on the pick itself. This coverage was lost when the
 * flow was extracted out of SkillProperties into this hook; here we assert both
 * halves: requestMove() does not touch disk, and confirming does.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const moveSkillScope = vi.fn(async () => ({ ok: true as const, skippedBinaryFiles: [] }));
const retarget = vi.fn(() => {});

// `useMoveSkillScope` reads DocumentContext to pin the Skills sidebar across a
// move and to resolve the open tab it must repoint. No provider here, so stub it.
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
  // Pulled in transitively by use-skills (the move hook now resolves the real
  // FROM doc from the list).
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

    // Pick a new level — this must NOT move files yet.
    await user.click(screen.getByText('pick-global'));
    expect(moveSkillScope).not.toHaveBeenCalled();

    // The confirm dialog is staged, offering the Move action.
    const confirm = await screen.findByTestId('skill-scope-move-confirm');

    // Confirming commits the relocation with the staged source/target scopes.
    await user.click(confirm);
    await waitFor(() => expect(moveSkillScope).toHaveBeenCalledTimes(1));
    expect(moveSkillScope).toHaveBeenCalledWith({
      name: 'foo',
      fromScope: 'project',
      toScope: 'global',
    });
  });
});
