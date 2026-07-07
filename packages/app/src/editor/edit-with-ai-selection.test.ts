/**
 * Unit tests for the "Edit with AI" selection serializers.
 *
 * The WYSIWYG path is exercised with a minimal `doc > paragraph > text`
 * schema against the real
 * shared `MarkdownManager` — `doc` / `paragraph` / `text` are universal node
 * names, so the real serialize pipeline handles the synthetic slice.
 */

import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { serializeWysiwygSelection } from './edit-with-ai-selection.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

function docOf(...paragraphs: string[]) {
  return schema.node(
    'doc',
    null,
    paragraphs.map((text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])),
  );
}

function editorSelecting(doc: ReturnType<typeof docOf>, from: number, to: number): Editor {
  return {
    state: { selection: { content: () => doc.slice(from, to) }, schema },
  } as unknown as Editor;
}

describe('serializeWysiwygSelection', () => {
  test('serializes a single-paragraph selection to markdown', () => {
    const doc = docOf('Rewrite this passage.');
    expect(serializeWysiwygSelection(editorSelecting(doc, 0, doc.content.size))).toBe(
      'Rewrite this passage.',
    );
  });

  test('preserves block structure across a multi-paragraph selection', () => {
    const doc = docOf('First paragraph.', 'Second paragraph.');
    expect(serializeWysiwygSelection(editorSelecting(doc, 0, doc.content.size))).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
  });

  test('returns the empty string for an empty selection', () => {
    const doc = docOf('hello');
    expect(serializeWysiwygSelection(editorSelecting(doc, 1, 1))).toBe('');
  });
});
