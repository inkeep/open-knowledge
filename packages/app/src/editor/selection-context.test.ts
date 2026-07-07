/**
 * Unit tests for the selection-context store + the source-mode extractor. The
 * store mirrors selection-stats (per-(docName, surface) publish/subscribe with
 * change-detection); the source extractor is the load-bearing line-number logic.
 * The source extractor reads only `view.state`, so a bare `EditorState` (no DOM)
 * exercises it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  getSelectionContext,
  INLINE_SELECTION_MAX_CHARS,
  lightRenderMarkdownPreview,
  publishSelectionContext,
  type SelectionSnapshot,
  selectionChipLabel,
  selectionSnapshotFromFrontmatter,
  selectionSnapshotFromSource,
  selectionSnapshotToCompose,
  subscribeSelectionContext,
} from './selection-context';

function snap(over: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return { surface: 'wysiwyg', docName: 'd', markdown: 'x', charLen: 1, lineCount: 1, ...over };
}

// A source view stub — the extractor only touches `view.state`.
function sourceView(doc: string, anchor: number, head: number): EditorView {
  return { state: EditorState.create({ doc, selection: { anchor, head } }) } as EditorView;
}

afterEach(() => {
  // Clear any entries this test left behind (the store is module-global).
  for (const surface of ['wysiwyg', 'source', 'frontmatter'] as const) {
    publishSelectionContext('d', surface, null);
    publishSelectionContext('notes', surface, null);
  }
});

describe('selection-context store', () => {
  test('publish then get returns the snapshot; null clears it', () => {
    const s = snap({ markdown: 'hello' });
    publishSelectionContext('d', 'wysiwyg', s);
    expect(getSelectionContext('d', 'wysiwyg')).toBe(s);
    publishSelectionContext('d', 'wysiwyg', null);
    expect(getSelectionContext('d', 'wysiwyg')).toBeNull();
  });

  test('keyed by surface — wysiwyg and source for the same doc do not collide', () => {
    const w = snap({ surface: 'wysiwyg', markdown: 'w' });
    const src = snap({ surface: 'source', markdown: 's', sourceLineStart: 2, sourceLineEnd: 2 });
    publishSelectionContext('d', 'wysiwyg', w);
    publishSelectionContext('d', 'source', src);
    expect(getSelectionContext('d', 'wysiwyg')).toBe(w);
    expect(getSelectionContext('d', 'source')).toBe(src);
  });

  test('subscribe fires on change but not on a value-identical re-publish', () => {
    let calls = 0;
    const unsub = subscribeSelectionContext(() => {
      calls += 1;
    });
    try {
      publishSelectionContext('d', 'wysiwyg', snap({ markdown: 'a' }));
      expect(calls).toBe(1);
      // Same passage + line range → no notify, and the stored ref is kept.
      const first = getSelectionContext('d', 'wysiwyg');
      publishSelectionContext('d', 'wysiwyg', snap({ markdown: 'a' }));
      expect(calls).toBe(1);
      expect(getSelectionContext('d', 'wysiwyg')).toBe(first);
      // Changed passage → notify.
      publishSelectionContext('d', 'wysiwyg', snap({ markdown: 'b' }));
      expect(calls).toBe(2);
    } finally {
      unsub();
    }
  });

  test('null publish only notifies when an entry existed', () => {
    let calls = 0;
    const unsub = subscribeSelectionContext(() => {
      calls += 1;
    });
    try {
      publishSelectionContext('d', 'wysiwyg', null);
      expect(calls).toBe(0);
    } finally {
      unsub();
    }
  });
});

describe('selectionSnapshotFromSource', () => {
  const doc = 'line one\nline two\nline three';

  test('single-line selection → lineCount 1 and the line number on both ends', () => {
    // "line two" spans offsets 9..17 (line 2).
    const out = selectionSnapshotFromSource(sourceView(doc, 9, 17), 'notes');
    expect(out).toEqual({
      surface: 'source',
      docName: 'notes',
      markdown: 'line two',
      charLen: 8,
      lineCount: 1,
      sourceLineStart: 2,
      sourceLineEnd: 2,
    });
  });

  test('multi-line selection → line range spanning the selected lines', () => {
    // From mid-line-2 to mid-line-3.
    const out = selectionSnapshotFromSource(sourceView(doc, 14, 22), 'notes');
    expect(out?.sourceLineStart).toBe(2);
    expect(out?.sourceLineEnd).toBe(3);
    expect(out?.lineCount).toBe(2);
  });

  test('collapsed selection → null', () => {
    expect(selectionSnapshotFromSource(sourceView(doc, 5, 5), 'notes')).toBeNull();
  });
});

describe('selectionSnapshotToCompose (inline vs reference rule)', () => {
  test('single line under the char limit → inline verbatim', () => {
    const out = selectionSnapshotToCompose(snap({ markdown: 'short', charLen: 5, lineCount: 1 }));
    expect(out).toEqual({ kind: 'inline', markdown: 'short' });
  });

  test('single line at/over the char limit → reference (source → lines)', () => {
    const long = 'a'.repeat(INLINE_SELECTION_MAX_CHARS);
    const out = selectionSnapshotToCompose(
      snap({
        surface: 'source',
        markdown: long,
        charLen: long.length,
        lineCount: 1,
        sourceLineStart: 4,
        sourceLineEnd: 4,
      }),
    );
    expect(out).toEqual({ kind: 'lines', startLine: 4, endLine: 4 });
  });

  test('multi-line in source mode → line range', () => {
    const out = selectionSnapshotToCompose(
      snap({
        surface: 'source',
        markdown: 'a\nb\nc',
        charLen: 5,
        lineCount: 3,
        sourceLineStart: 10,
        sourceLineEnd: 12,
      }),
    );
    expect(out).toEqual({ kind: 'lines', startLine: 10, endLine: 12 });
  });

  test('multi-line in rich text (no line numbers) → anchor', () => {
    const out = selectionSnapshotToCompose(
      snap({ surface: 'wysiwyg', markdown: 'a\nb\nc', charLen: 5, lineCount: 3 }),
    );
    expect(out).toEqual({ kind: 'anchor', markdown: 'a\nb\nc' });
  });
});

describe('selectionChipLabel (compact Cursor-style label)', () => {
  test('a source line range shows `name (start-end)`', () => {
    expect(
      selectionChipLabel(
        snap({ surface: 'source', sourceLineStart: 10, sourceLineEnd: 12, lineCount: 3 }),
        'notes.md',
      ),
    ).toBe('notes.md (10-12)');
  });

  test('a single source line shows `name (line)`', () => {
    expect(
      selectionChipLabel(
        snap({ surface: 'source', sourceLineStart: 7, sourceLineEnd: 7, lineCount: 1 }),
        'notes.md',
      ),
    ).toBe('notes.md (7)');
  });

  test('a multi-line rich-text selection shows the extent; single-line shows `(selection)`', () => {
    expect(selectionChipLabel(snap({ lineCount: 4 }), 'notes.md')).toBe('notes.md (4 lines)');
    expect(selectionChipLabel(snap({ lineCount: 1 }), 'notes.md')).toBe('notes.md (selection)');
  });

  test('never leaks raw markdown from the passage', () => {
    expect(
      selectionChipLabel(snap({ markdown: '## Heading', lineCount: 1 }), 'notes.md'),
    ).not.toContain('##');
  });
});

describe('lightRenderMarkdownPreview', () => {
  test('strips heading markers; newlines collapse', () => {
    expect(lightRenderMarkdownPreview('## Heading')).toBe('Heading');
    expect(lightRenderMarkdownPreview('### A\n#### B')).toBe('A B');
  });

  test('list items become a • glyph (unordered + ordered)', () => {
    expect(lightRenderMarkdownPreview('- one\n- two')).toBe('• one • two');
    expect(lightRenderMarkdownPreview('* a\n+ b')).toBe('• a • b');
    expect(lightRenderMarkdownPreview('1. first\n2. second')).toBe('• first • second');
  });

  test('a heading + list selection leaks no literal ## / - markdown', () => {
    const preview = lightRenderMarkdownPreview('## Heading\n- item one\n- item two');
    expect(preview).toContain('Heading');
    expect(preview).toContain('• item one');
    expect(preview).not.toContain('##');
    expect(preview).not.toContain('- item');
  });

  test('code fence → `code`; table → `table`; MDX/HTML → `component`', () => {
    expect(lightRenderMarkdownPreview('```ts\nconst x = 1;\n```')).toBe('code');
    expect(lightRenderMarkdownPreview('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('table');
    expect(lightRenderMarkdownPreview('<Callout type="note">\nhi\n</Callout>')).toContain(
      'component',
    );
  });

  test('blockquote markers drop; prose preserved', () => {
    expect(lightRenderMarkdownPreview('> quoted line')).toBe('quoted line');
    expect(lightRenderMarkdownPreview('just prose')).toBe('just prose');
  });
});

describe('selectionSnapshotFromFrontmatter', () => {
  test('builds a frontmatter-surface snapshot from highlighted text', () => {
    expect(selectionSnapshotFromFrontmatter('a description value', 'notes')).toMatchObject({
      surface: 'frontmatter',
      docName: 'notes',
      markdown: 'a description value',
      lineCount: 1,
    });
  });

  test('returns null for empty / whitespace-only text', () => {
    expect(selectionSnapshotFromFrontmatter('', 'notes')).toBeNull();
    expect(selectionSnapshotFromFrontmatter('   \n  ', 'notes')).toBeNull();
  });

  test('counts lines across a multi-line property selection', () => {
    expect(selectionSnapshotFromFrontmatter('a\nb\nc', 'notes')?.lineCount).toBe(3);
  });
});
