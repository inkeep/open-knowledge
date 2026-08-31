/**
 * Pins the two guards on the conflict composer prefill.
 *
 * The seed writes into the user's typing surface, and its draft is global +
 * localStorage-backed — so a seed that clobbers, or one that is never withdrawn,
 * follows the user well past the conflict that justified it.
 *
 * Substrate: jsdom.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let conflictsState: { conflicts: { file: string; detectedAt: string }[] } = { conflicts: [] };
vi.doMock('@/hooks/use-conflicts', () => ({ useConflicts: () => conflictsState }));

const { useConflictComposerPrefill } = await import('./use-conflict-composer-prefill');

const ENTRY = { file: 'notes/roadmap.md', detectedAt: '2026-08-25T00:00:00.000Z' };
const DOC2 = { file: 'notes/doc2.md', detectedAt: '2026-08-25T00:00:00.000Z' };

/**
 * Stand-in for the composer input handle. `setText` and `clear` invoke the
 * content-change callback synchronously because the real `ComposerMentionInput`
 * does — `setContent` does not fire `onUpdate`, so the handle calls the host
 * back by hand. A fake that only assigns hides every self-notification bug.
 */
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
    /** Wire the host's content-change relay, as BottomComposer's prop does. */
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
  test('seeds the resolve instruction for a conflicted doc', () => {
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput();
    renderHook(() => useConflictComposerPrefill('notes/roadmap', { current: input }));

    // "all" is the payload's one constraint: every region, not just the first.
    expect(input.read()).toBe('Resolve all the merge conflicts in notes/roadmap.md.');
  });

  test('leaves an unconflicted doc alone', () => {
    const input = makeInput();
    renderHook(() => useConflictComposerPrefill('notes/team', { current: input }));
    expect(input.read()).toBe('');
  });

  test('never clobbers a draft the user is part-way through', () => {
    // Reachable in normal use: conflicts arrive from a background sync, not only
    // from a navigation the user initiated.
    conflictsState = { conflicts: [ENTRY] };
    const input = makeInput('what does this function do?');
    renderHook(() => useConflictComposerPrefill('notes/roadmap', { current: input }));
    expect(input.read()).toBe('what does this function do?');
  });

  test('re-seeds when switching to another conflicted doc', () => {
    // Clicking between conflicted files left the instruction naming the file the
    // user had just left, because a seeded draft reads as "occupied".
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
    // The composer attaches every doc visited "while still drafting". A seed
    // nobody typed must not count, or clicking through conflicts silently
    // attaches them all.
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
    // `setText` calls the host's change handler synchronously, so the seed's own
    // write arrives looking exactly like typing.
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
    // The draft persists to localStorage, so a seed outlives the process that
    // wrote it and returns at mount looking exactly like the user typed it.
    // Reading it as a draft in progress is what made every clicked doc attach.
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
    // Restored while the user is now looking at doc2.
    const input = makeInput('Resolve all the merge conflicts in notes/roadmap.md.');
    renderHook(() => useConflictComposerPrefill('notes/doc2', { current: input }));
    expect(input.read()).toBe('Resolve all the merge conflicts in notes/doc2.md.');
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
});
