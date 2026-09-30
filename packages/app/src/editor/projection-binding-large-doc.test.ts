import { buildProjection, MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createProjectionBinding,
  fullProjection,
  type ProjectionBinding,
} from './projection-binding';
import { installDomGlobals } from './walk-currency-test-harness';

const md = new MarkdownManager({ extensions: sharedExtensions, deriveStructuralFreshness: true });
const USER = Symbol('local-user');
const PEER = Symbol('peer');
const TARGET_BYTES = 480 * 1024;
const EDITS = 20;
const BUDGET_SHARE_OF_FULL_PARSE = 0.1;

let restoreDom: (() => void) | undefined;
beforeAll(() => {
  restoreDom = installDomGlobals();
});
afterAll(() => {
  restoreDom?.();
});

function largeDocument(targetBytes: number): string {
  const parts = ['# Large Document\n\n'];
  let length = parts[0]?.length ?? 0;
  for (let i = 1; length < targetBytes; i++) {
    const section =
      `## Section ${i}\n\n` +
      `Paragraph ${i} of the large document, long enough that a whole-document parse costs ` +
      'what a book-length file costs, not what a toy one does.\n\n' +
      `- item one of section ${i}\n- item two of section ${i}\n\n`;
    parts.push(section);
    length += section.length;
  }
  return parts.join('');
}

interface Rig {
  editor: Editor;
  ytext: Y.Text;
  ydoc: Y.Doc;
  binding: ProjectionBinding;
  destroy(): void;
}

let rig: Rig | null = null;
afterEach(() => {
  rig?.destroy();
  rig = null;
});

function mount(source: string): Rig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const binding = createProjectionBinding({ ytext, md, origin: USER });
  const editor = new Editor({
    element: host,
    content: binding.content,
    extensions: [...sharedExtensions, binding.extension],
  });
  rig = {
    editor,
    ytext,
    ydoc,
    binding,
    destroy() {
      editor.destroy();
      host.remove();
      ydoc.destroy();
    },
  };
  return rig;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function fullParseMs(source: string): number {
  buildProjection(source, md);
  const start = performance.now();
  buildProjection(source, md);
  return performance.now() - start;
}

function blockStart(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function paragraphIndex(doc: PmNode, text: string): number {
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).textContent.startsWith(text)) return i;
  }
  throw new Error(`no block starting with ${text}`);
}

describe('projection binding on a book-length document', () => {
  it('applies a peer keystroke as one block, with no document parse, at a fraction of a full parse', () => {
    const source = largeDocument(TARGET_BYTES);
    const { editor, ytext, ydoc, binding } = mount(source);
    const caretBlock = paragraphIndex(editor.state.doc, 'Paragraph 5 of');
    const caretPos = blockStart(editor.state.doc, caretBlock) + 1 + 'Paragraph 5'.length;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, caretPos)),
    );

    const children = Array.from({ length: editor.state.doc.childCount }, (_, i) =>
      editor.state.doc.child(i),
    );
    const rebuilds = binding.stats.rebuilds;
    const at = source.indexOf('Paragraph 1000 of') + 'Paragraph 1000'.length;
    const timings: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      const start = performance.now();
      ydoc.transact(() => ytext.insert(at + i, 'x'), PEER);
      timings.push(performance.now() - start);
    }

    const doc = editor.state.doc;
    expect(doc.childCount).toBe(children.length);
    const replaced = children.filter((node, i) => doc.child(i) !== node);
    expect(replaced).toHaveLength(1);
    expect(doc.child(paragraphIndex(doc, 'Paragraph 1000x')).textContent).toContain(
      `Paragraph 1000${'x'.repeat(EDITS)} of`,
    );
    expect(binding.stats.rebuilds).toBe(rebuilds);
    expect(binding.stats.windowReparses).toBe(EDITS);

    const { $head } = editor.state.selection;
    expect($head.parent.textContent.startsWith('Paragraph 5 of')).toBe(true);
    expect($head.parentOffset).toBe('Paragraph 5'.length);

    const full = fullParseMs(ytext.toString());
    expect(median(timings)).toBeLessThan(full * BUDGET_SHARE_OF_FULL_PARSE);
  }, 120_000);

  it('resolves full precision after a local keystroke without a document parse', () => {
    const source = largeDocument(TARGET_BYTES);
    const { editor, ytext, ydoc } = mount(source);
    ydoc.transact(() => ytext.insert(source.indexOf('Paragraph 2000 of'), 'Peer. '), PEER);
    const block = paragraphIndex(editor.state.doc, 'Paragraph 3 of');
    const end = blockStart(editor.state.doc, block) + editor.state.doc.child(block).nodeSize - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));

    const timings: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      editor.view.dispatch(editor.state.tr.insertText('y'));
      const start = performance.now();
      fullProjection(editor.state);
      timings.push(performance.now() - start);
    }

    const resolved = fullProjection(editor.state);
    const rebuilt = buildProjection(ytext.toString(), md);
    expect(resolved?.source).toBe(rebuilt.source);
    expect(resolved?.map.precision).toBe('full');
    expect(resolved?.map.spans).toEqual(rebuilt.map.spans);

    const full = fullParseMs(ytext.toString());
    expect(median(timings)).toBeLessThan(full * BUDGET_SHARE_OF_FULL_PARSE);
  }, 120_000);
});
