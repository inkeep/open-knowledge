import { describe, expect, test } from 'bun:test';
import type { EditorView } from '@codemirror/view';
import type { Editor } from '@tiptap/core';
import {
  getSelectionStats,
  publishSelectionStats,
  selectionStatsFromSource,
  selectionStatsFromWysiwyg,
  subscribeSelectionStats,
} from './selection-stats';

describe('selection-stats store', () => {
  test('get returns null for an unknown or null docName', () => {
    expect(getSelectionStats('store-missing', 'wysiwyg')).toBeNull();
    expect(getSelectionStats(null, 'wysiwyg')).toBeNull();
  });

  test('publish then get returns the stats; null clears the entry', () => {
    const doc = 'store-roundtrip';
    const stats = { words: 2, chars: 11, tokens: 3 };
    publishSelectionStats(doc, 'wysiwyg', stats);
    expect(getSelectionStats(doc, 'wysiwyg')).toEqual(stats);
    publishSelectionStats(doc, 'wysiwyg', null);
    expect(getSelectionStats(doc, 'wysiwyg')).toBeNull();
  });

  test('entries are isolated per docName', () => {
    publishSelectionStats('store-a', 'wysiwyg', { words: 1, chars: 1, tokens: 1 });
    publishSelectionStats('store-b', 'wysiwyg', { words: 9, chars: 9, tokens: 9 });
    expect(getSelectionStats('store-a', 'wysiwyg')).toEqual({ words: 1, chars: 1, tokens: 1 });
    expect(getSelectionStats('store-b', 'wysiwyg')).toEqual({ words: 9, chars: 9, tokens: 9 });
    publishSelectionStats('store-a', 'wysiwyg', null);
    publishSelectionStats('store-b', 'wysiwyg', null);
  });

  // Regression: a doc kept in both surfaces (one Activity-hidden) must not let
  // the hidden editor's publish clobber the visible editor's entry. Separate
  // surface keys for the same doc are independent.
  test('the two surfaces for one doc do not clobber each other', () => {
    const doc = 'store-two-surface';
    publishSelectionStats(doc, 'wysiwyg', { words: 5, chars: 30, tokens: 8 });
    // Hidden source editor fires on a bridge-driven docChange and publishes its
    // collapsed (null) selection. This must NOT clear the WYSIWYG entry.
    publishSelectionStats(doc, 'source', null);
    expect(getSelectionStats(doc, 'wysiwyg')).toEqual({ words: 5, chars: 30, tokens: 8 });
    expect(getSelectionStats(doc, 'source')).toBeNull();
    // And the reverse direction.
    publishSelectionStats(doc, 'source', { words: 2, chars: 4, tokens: 1 });
    publishSelectionStats(doc, 'wysiwyg', null);
    expect(getSelectionStats(doc, 'source')).toEqual({ words: 2, chars: 4, tokens: 1 });
    expect(getSelectionStats(doc, 'wysiwyg')).toBeNull();
    publishSelectionStats(doc, 'source', null);
  });

  test('subscribers fire on publish and on clearing an existing entry, not on no-op clears', () => {
    const doc = 'store-notify';
    let calls = 0;
    const unsub = subscribeSelectionStats(() => {
      calls++;
    });
    publishSelectionStats(doc, 'wysiwyg', { words: 1, chars: 1, tokens: 1 }); // set → notify
    publishSelectionStats(doc, 'wysiwyg', null); // existing entry removed → notify
    publishSelectionStats(doc, 'wysiwyg', null); // already absent → no notify
    unsub();
    publishSelectionStats(doc, 'wysiwyg', { words: 2, chars: 2, tokens: 2 }); // after unsub → no notify
    expect(calls).toBe(2);
    publishSelectionStats(doc, 'wysiwyg', null);
  });

  test('publishing identical values is a no-op (no notify, stable reference)', () => {
    const doc = 'store-stable-ref';
    publishSelectionStats(doc, 'wysiwyg', { words: 3, chars: 12, tokens: 3 });
    const ref1 = getSelectionStats(doc, 'wysiwyg');
    let calls = 0;
    const unsub = subscribeSelectionStats(() => {
      calls++;
    });
    // A fresh object with identical values (what the extraction helpers mint).
    publishSelectionStats(doc, 'wysiwyg', { words: 3, chars: 12, tokens: 3 });
    expect(calls).toBe(0);
    expect(getSelectionStats(doc, 'wysiwyg')).toBe(ref1); // same reference retained
    // A real value change notifies and swaps the reference.
    publishSelectionStats(doc, 'wysiwyg', { words: 4, chars: 12, tokens: 3 });
    expect(calls).toBe(1);
    unsub();
    publishSelectionStats(doc, 'wysiwyg', null);
  });
});

function fakeWysiwygEditor(text: string, empty: boolean): Editor {
  return {
    state: {
      selection: { from: 0, to: text.length, empty },
      doc: { textBetween: () => text },
    },
  } as unknown as Editor;
}

describe('selectionStatsFromWysiwyg', () => {
  test('collapsed selection returns null', () => {
    expect(selectionStatsFromWysiwyg(fakeWysiwygEditor('hello', true))).toBeNull();
  });

  test('whitespace-only selection returns null', () => {
    expect(selectionStatsFromWysiwyg(fakeWysiwygEditor('   ', false))).toBeNull();
  });

  test('non-empty selection counts visible text directly', () => {
    expect(selectionStatsFromWysiwyg(fakeWysiwygEditor('hello world', false))).toEqual({
      words: 2,
      chars: 11,
      tokens: 3,
    });
  });
});

function fakeSourceView(ranges: Array<{ from: number; to: number; text: string }>): EditorView {
  return {
    state: {
      selection: {
        ranges: ranges.map((r) => ({ from: r.from, to: r.to, empty: r.from === r.to })),
      },
      sliceDoc: (from: number, to: number) =>
        ranges.find((r) => r.from === from && r.to === to)?.text ?? '',
    },
  } as unknown as EditorView;
}

describe('selectionStatsFromSource', () => {
  test('no non-empty ranges returns null', () => {
    expect(selectionStatsFromSource(fakeSourceView([{ from: 3, to: 3, text: '' }]))).toBeNull();
  });

  test('raw markdown selection is stripped to visible-text stats', () => {
    // "## Hello" in source ≡ "Hello" in WYSIWYG.
    expect(
      selectionStatsFromSource(fakeSourceView([{ from: 0, to: 8, text: '## Hello' }])),
    ).toEqual({ words: 1, chars: 5, tokens: 2 });
  });

  test('multi-range (multi-cursor) selection sums across ranges', () => {
    const stats = selectionStatsFromSource(
      fakeSourceView([
        { from: 0, to: 5, text: 'hello' },
        { from: 10, to: 15, text: 'world' },
      ]),
    );
    expect(stats?.words).toBe(2);
  });
});
