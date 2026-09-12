import type {
  SkillMoveStateCode,
  SkillRetentionLedgerCode,
  SkillSourceStateCode,
} from '@inkeep/open-knowledge-core';
import { interpretSkillMoveFailure } from '@inkeep/open-knowledge-core';
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
vi.doMock('@/lib/skills-api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/skills-api')>('@/lib/skills-api')),
  moveSkillScope: vi.fn(async () => ({ ok: true })),
}));
const toastError = vi.fn();
const toastDismiss = vi.fn();
vi.doMock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), dismiss: toastDismiss },
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
    vi.mocked(api.moveSkillScope).mockResolvedValueOnce({
      ok: false,
      error: 'nope',
      outcome: interpretSkillMoveFailure({}),
      droppedLocations: [],
    });
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

describe('a failed move reports the retained copy it actually left behind', () => {
  type ToastOptions = { description?: string; id?: string; duration?: number };

  async function failWith(state: {
    moveState?: SkillMoveStateCode;
    sourceState?: SkillSourceStateCode;
    retentionLedger?: SkillRetentionLedgerCode;
  }): Promise<ToastOptions | undefined> {
    toastError.mockClear();
    const api = await import('@/lib/skills-api');
    const reported = {
      ...(state.moveState ? { moveState: state.moveState } : {}),
      ...(state.sourceState ? { sourceState: state.sourceState } : {}),
      ...(state.retentionLedger ? { retentionLedger: state.retentionLedger } : {}),
    };
    vi.mocked(api.moveSkillScope).mockResolvedValueOnce({
      ok: false,
      error: "A global skill named 'trip-log' already exists.",
      droppedLocations: [],
      outcome: interpretSkillMoveFailure(reported),
    });
    const { result } = renderHook(() => useMoveSkillScope());

    await result.current({ scope: 'project', name: 'trip-log' }, 'global');

    const call = toastError.mock.calls.at(-1) as [string, ToastOptions | undefined];
    return call[1];
  }

  test('a verified-intact source makes the retained copy a duplicate to remove before retrying', async () => {
    const options = await failWith({
      moveState: 'destination-retained',
      sourceState: 'intact',
    });

    expect(options?.description).toContain('redundant duplicate');
    expect(options?.description).toContain('Remove that copy, then retry the move.');
    expect(options?.description).not.toContain("Don't delete it");
  });

  test('a source that is not verified intact keeps the do-not-delete warning', async () => {
    for (const sourceState of ['lossy', 'unknown', undefined] as const) {
      const options = await failWith({ moveState: 'destination-retained', sourceState });

      expect(options?.description).toMatch(/Don't delete (it|anything)/);
      expect(options?.description).toContain('comparing it with the original');
      expect(options?.description).not.toContain('redundant duplicate');
    }
  });

  test('the intact and not-intact arms cannot collapse back into one sentence', async () => {
    const intact = await failWith({ moveState: 'destination-retained', sourceState: 'intact' });
    const lossy = await failWith({ moveState: 'destination-retained', sourceState: 'lossy' });

    expect(intact?.description).not.toBe(lossy?.description);
  });

  test('a blocked retry reports the blocking retained copy the same way', async () => {
    expect(
      (await failWith({ moveState: 'destination-retained-blocking', sourceState: 'intact' }))
        ?.description,
    ).toContain('redundant duplicate');
    expect(
      (await failWith({ moveState: 'destination-retained-blocking', sourceState: 'lossy' }))
        ?.description,
    ).toContain("Don't delete it");
  });

  test('the guidance names the destination scope and the skill it is talking about', async () => {
    const options = await failWith({
      moveState: 'destination-retained',
      sourceState: 'unknown',
    });

    expect(options?.description).toContain('Global');
    expect(options?.description).toContain('trip-log');
  });

  test('a retained copy pins the toast open under a per-skill id', async () => {
    const first = await failWith({ moveState: 'destination-retained', sourceState: 'intact' });
    const second = await failWith({
      moveState: 'destination-retained-blocking',
      sourceState: 'lossy',
    });

    expect(first?.duration).toBe(Infinity);
    expect(second?.duration).toBe(Infinity);
    expect(first?.id).toBe('skill-move-retained:global:trip-log');
    expect(second?.id).toBe(first?.id);
  });

  test('a retention-ledger code warns about the unverifiable occupant on an otherwise-quiet moveState', async () => {
    for (const retentionLedger of ['unreadable', 'occupant-unverifiable'] as const) {
      const options = await failWith({ moveState: 'nothing-written', retentionLedger });

      expect(options?.description).toContain("couldn't confirm what it is");
      expect(options?.description).toContain('trip-log');
      expect(options?.description).toContain('Global');
      expect(options?.duration).toBe(Infinity);
      expect(options?.id).toBe('skill-move-retained:global:trip-log');
    }
  });

  test('an ordinary failure adds no guidance and keeps the default toast lifetime', async () => {
    for (const state of [{ moveState: 'destination-removed' as const }, {}]) {
      const options = await failWith(state);

      expect(options?.description).toBeUndefined();
      expect(options?.duration).toBeUndefined();
      expect(options?.id).toBeUndefined();
    }
  });
});
