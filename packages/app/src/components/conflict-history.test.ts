// @vitest-environment node
import { describe, expect, test } from 'vitest';
import type { ConflictSnapshot } from './conflict-history';
import { ConflictHistory } from './conflict-history';

function snap(contents: string): ConflictSnapshot {
  return { file: { name: 'f.md', contents } };
}

describe('ConflictHistory', () => {
  test('undo on the initial entry returns null — no-op on empty history', () => {
    const h = new ConflictHistory(snap('initial'));
    expect(h.undo()).toBeNull();
    expect(h.canUndo).toBe(false);
    expect(h.current.file.contents).toBe('initial');
  });

  test('undo after a push restores the previous snapshot — accept becomes undoable', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('resolved'));

    const prev = h.undo();
    expect(prev?.file.contents).toBe('initial');
    expect(h.canUndo).toBe(false);
  });

  test('undo after an incoming resolution still works', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('after-incoming'));

    const prev = h.undo();
    expect(prev?.file.contents).toBe('initial');
  });

  test('resolving every conflict then undoing brings back the last unresolved snapshot', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('partial'));
    h.push(snap('all-done'));

    const prev = h.undo();
    expect(prev?.file.contents).toBe('partial');
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(true);
  });

  test('undo is most-recent-first when mixing resolution types', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('after-current'));
    h.push(snap('after-incoming'));

    const first = h.undo();
    expect(first?.file.contents).toBe('after-current');

    const second = h.undo();
    expect(second?.file.contents).toBe('initial');
    expect(h.canUndo).toBe(false);
  });

  test('redo re-applies the undone resolution', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('resolved'));
    h.undo();
    expect(h.canRedo).toBe(true);

    const redone = h.redo();
    expect(redone?.file.contents).toBe('resolved');
    expect(h.canRedo).toBe(false);
  });

  test('push after undo truncates the redo stack', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('first'));
    h.undo();
    h.push(snap('alternate'));

    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
  });

  test('restored state is byte-identical to the pushed snapshot', () => {
    const h = new ConflictHistory(snap('initial'));
    const bytes = 'content\x00\x01\nbyte-exact\r\n\tleading-tab   \n';
    h.push(snap(bytes));

    h.undo();
    h.redo();
    expect(h.current.file.contents).toBe(bytes);
  });

  test('depth cap preserves the initial entry and the most-recent MAX_DEPTH entries', () => {
    const h = new ConflictHistory(snap('initial'));
    for (let i = 0; i < 55; i++) {
      h.push(snap(`step-${i}`));
    }
    expect(h.canUndo).toBe(true);
    expect(h.current.file.contents).toBe('step-54');
  });

  test('reset backfills the initial entry so undo returns a snapshot with fileDiff', () => {
    const h = new ConflictHistory(snap('initial'));
    h.push(snap('resolved'));
    const fullInitial: ConflictSnapshot = {
      file: { name: 'f.md', contents: 'initial' },
      // biome-ignore lint/suspicious/noExplicitAny: partial stub of Pierre's FileDiffMetadata for this test
      fileDiff: { additionLines: ['resolved\n'], deletionLines: ['initial\n'] } as any,
    };
    h.reset(fullInitial);
    const prev = h.undo();
    expect(prev?.fileDiff).toBeDefined();
    expect(prev?.file.contents).toBe('initial');
    expect(h.undo()).toBeNull();
  });
});
