import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let conflictsState: {
  conflicts: { file: string; detectedAt: string; docName: string }[];
} = {
  conflicts: [],
};
vi.doMock('@/hooks/use-conflicts', () => ({ useConflicts: () => conflictsState }));
vi.doMock('@/lib/conflict-resolve-draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/conflict-resolve-draft')>();
  const { i18n } = await import('@lingui/core');
  return {
    ...actual,
    buildResolveDraft: (filePath: string) =>
      i18n.locale === 'hi'
        ? `hi: ${actual.buildResolveDraft(filePath)}`
        : actual.buildResolveDraft(filePath),
  };
});

const { useConflictComposerPrefill } = await import('./use-conflict-composer-prefill');

const ENTRY = {
  file: 'notes/roadmap.md',
  detectedAt: '2026-08-25T00:00:00.000Z',
  docName: 'notes/roadmap',
};
const DOC2 = {
  file: 'notes/doc2.md',
  detectedAt: '2026-08-25T00:00:00.000Z',
  docName: 'notes/doc2',
};

function makeInput(initial = '') {
  let text = initial;
  let onChange: (() => void) | null = null;
  return {
    getContent: () => ({ instruction: text, mentions: [] as string[] }),
    setText: (next: string) => {
      text = next;
      onChange?.();
    },
    clear: () => {
      text = '';
      onChange?.();
    },
    read: () => text,
    wire: (cb: () => void) => {
      onChange = cb;
    },
  };
}

beforeEach(() => {
  conflictsState = { conflicts: [] };
});
afterEach(() => vi.clearAllMocks());

describe('useConflictComposerPrefill', () => {
  test('seeds guidance without asking the agent to apply a conflict resolution', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput();
    renderHook(() => useConflictComposerPrefill('notes/roadmap', { current: input }));

    expect(input.read()).toContain('Help me understand the conflict in notes/roadmap.md.');
    expect(input.read()).toContain('I will choose and apply the resolution there.');
  });

  test('leaves an unconflicted doc alone', () => {
    const input = makeInput();
    renderHook(() => useConflictComposerPrefill('notes/team', { current: input }));
    expect(input.read()).toBe('');
  });

  test('never clobbers a draft the user is part-way through', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput('what does this function do?');
    renderHook(() => useConflictComposerPrefill('notes/roadmap', { current: input }));
    expect(input.read()).toBe('what does this function do?');
  });

  test('re-seeds when switching to another conflicted doc', () => {
    conflictsState = { conflicts: [ENTRY, DOC2] };
    const input = makeInput();
    const { rerender } = renderHook(
      ({ doc }) => useConflictComposerPrefill(doc, { current: input }),
      { initialProps: { doc: 'notes/roadmap' as string | null } },
    );
    expect(input.read()).toContain('notes/roadmap.md');

    rerender({ doc: 'notes/doc2' });
    expect(input.read()).toContain('notes/doc2.md');
    expect(input.read()).not.toContain('notes/roadmap.md');
  });

  test('reports an untouched seed as not-composing, and an edited one as composing', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput();
    const { result, rerender } = renderHook(() =>
      useConflictComposerPrefill('notes/roadmap', { current: input }),
    );
    expect(result.current.isSeedIntact).toBe(true);

    input.setText(`${input.read()} Keep my Region 2.`);
    act(() => result.current.onContentChanged());
    rerender();
    expect(result.current.isSeedIntact).toBe(false);
  });

  test('a re-seed does not retire itself as a user edit', () => {
    conflictsState = { conflicts: [ENTRY, DOC2] };
    const input = makeInput();
    const { result, rerender } = renderHook(
      ({ doc }) => useConflictComposerPrefill(doc, { current: input }),
      { initialProps: { doc: 'notes/roadmap' as string | null } },
    );
    input.wire(() => result.current.onContentChanged());

    rerender({ doc: 'notes/doc2' });
    expect(result.current.isSeedIntact).toBe(true);
    expect(input.read()).toContain('notes/doc2.md');
  });

  test('recognises a seed restored from a previous session', () => {
    conflictsState = { conflicts: [ENTRY, DOC2] };
    const restored = 'Resolve all the merge conflicts in notes/roadmap.md.';
    const input = makeInput(restored);
    const { result } = renderHook(() =>
      useConflictComposerPrefill('notes/roadmap', { current: input }),
    );
    expect(result.current.isSeedIntact).toBe(true);
  });

  test('re-targets a restored seed for the doc actually open', () => {
    conflictsState = { conflicts: [ENTRY, DOC2] };
    const input = makeInput('Resolve all the merge conflicts in notes/roadmap.md.');
    renderHook(() => useConflictComposerPrefill('notes/doc2', { current: input }));
    expect(input.read()).toContain('notes/doc2.md');
    expect(input.read()).toContain('I will choose and apply the resolution there.');
  });

  test('a restored draft the user actually wrote is left alone', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput('what changed in this file last week?');
    const { result } = renderHook(() =>
      useConflictComposerPrefill('notes/roadmap', { current: input }),
    );
    expect(result.current.isSeedIntact).toBe(false);
    expect(input.read()).toBe('what changed in this file last week?');
  });

  test('withdraws its own seed once the conflict is gone', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput();
    const { rerender } = renderHook(
      ({ doc }) => useConflictComposerPrefill(doc, { current: input }),
      { initialProps: { doc: 'notes/roadmap' as string | null } },
    );
    expect(input.read()).not.toBe('');

    conflictsState = { conflicts: [] };
    rerender({ doc: 'notes/roadmap' });
    expect(input.read()).toBe('');
  });

  test('keeps an edited seed — it is the user’s text now', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput();
    const { rerender } = renderHook(
      ({ doc }) => useConflictComposerPrefill(doc, { current: input }),
      { initialProps: { doc: 'notes/roadmap' as string | null } },
    );
    input.setText(`${input.read()}\n\nKeep my Region 2.`);

    conflictsState = { conflicts: [] };
    rerender({ doc: 'notes/roadmap' });
    expect(input.read()).toContain('Keep my Region 2.');
  });

  test('recognises a restored seed once the locale it was written in activates', async () => {
    const { i18n } = await import('@lingui/core');
    const { buildResolveDraft } = await vi.importActual<
      typeof import('@/lib/conflict-resolve-draft')
    >('@/lib/conflict-resolve-draft');
    const previous = i18n.locale;
    const restored = `hi: ${buildResolveDraft('notes/roadmap.md')}`;
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput(restored);
    const inputRef = { current: input };
    try {
      act(() => i18n.loadAndActivate({ locale: 'en', messages: {} }));
      const { result, rerender } = renderHook(() =>
        useConflictComposerPrefill('notes/roadmap', inputRef),
      );
      expect(result.current.isSeedIntact).toBe(false);
      expect(input.read()).toBe(restored);

      act(() => i18n.loadAndActivate({ locale: 'hi', messages: {} }));
      rerender();
      expect(result.current.isSeedIntact).toBe(true);

      conflictsState = { conflicts: [] };
      rerender();
      expect(input.read()).toBe('');
    } finally {
      act(() => i18n.loadAndActivate({ locale: previous || 'en', messages: {} }));
    }
  });
});
