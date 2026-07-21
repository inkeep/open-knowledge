/**
 * Mixed-payload paste placement at a list-interior caret.
 *
 * Pasting a payload that is NOT 100% lists (heading+list, paragraph+list,
 * code block+list, lone/multiple headings, list+heading) at a caret inside a
 * list item must SPLIT the list at the caret and place the non-list blocks as
 * siblings of the list — the placement typing them at top level would produce
 * — while leading/trailing list runs in the payload splice as item siblings
 * (list continuation), mirroring the all-list sibling-splice path. Nothing may
 * be demoted into the target list item.
 *
 * Each test mounts a real TipTap editor over the core schema (real list
 * nodes, real MarkdownManager) and drives the REAL createHandlePaste
 * dispatcher, so the whole path runs: markdown-first tiebreak →
 * MarkdownManager.parse → applyJsonSlice → buildListSiblingSpliceTr.
 */

import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { installDomGlobals } from '../walk-currency-test-harness';

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return { ...actual, toast: { error: vi.fn() } };
});

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

let createHandlePaste: typeof import('./handle-paste').createHandlePaste;

let restoreDomGlobals: (() => void) | null = null;
const editors: Editor[] = [];

beforeAll(async () => {
  restoreDomGlobals = installDomGlobals();
  ({ createHandlePaste } = await import('./handle-paste'));
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function mountEditor(md: string): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content: mdManager.parse(md) as JSONContent,
    extensions: [...sharedExtensions],
  });
  editors.push(editor);
  return editor;
}

type PasteFlavor = 'B' | 'E' | 'D';

/** Drive the dispatcher with clipboard payloads shaped to hit a specific branch. */
function paste(
  editor: Editor,
  flavor: PasteFlavor,
  payload: { md?: string; html?: string },
): boolean {
  const plain = payload.md ?? '';
  const html = payload.html ?? '';
  const types: string[] = [];
  if (flavor === 'B') types.push('text/plain', 'text/html');
  if (flavor === 'E') types.push('text/plain');
  if (flavor === 'D') types.push('text/html');
  const dt = {
    clipboardData: {
      types,
      getData: (k: string) => {
        if (k === 'text/plain' && flavor !== 'D') return plain;
        if (k === 'text/html' && flavor !== 'E') return html || '<ul><li>x</li></ul>';
        return '';
      },
    },
  } as unknown as ClipboardEvent;
  return createHandlePaste({ mdManager })(editor.view, dt);
}

/** Doc position of the nth list item's first paragraph (0-based, doc order). */
function itemParaRange(doc: ProseMirrorNode, n: number): { start: number; end: number } {
  let i = 0;
  let found: { start: number; end: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'listItem') {
      if (i === n) {
        const para = node.firstChild;
        const start = pos + 2;
        found = { start, end: start + (para ? para.content.size : 0) };
        return false;
      }
      i++;
    }
    return true;
  });
  if (!found) throw new Error(`listItem ${n} not found`);
  return found;
}

function setCaret(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Where did the pasted heading land? */
function headingPlacement(doc: ProseMirrorNode): 'top-level' | 'inside-list' | 'absent' {
  let topLevel = false;
  doc.forEach((node) => {
    if (node.type.name === 'heading') topLevel = true;
  });
  if (topLevel) return 'top-level';
  let insideList = false;
  doc.descendants((node) => {
    if (node.type.name === 'heading') {
      insideList = true;
      return false;
    }
    return true;
  });
  return insideList ? 'inside-list' : 'absent';
}

function serialize(editor: Editor): string {
  return mdManager.serialize(editor.getJSON() as JSONContent);
}

function topLevelTypes(doc: ProseMirrorNode): string[] {
  const names: string[] = [];
  doc.forEach((node) => {
    names.push(node.type.name);
  });
  return names;
}

const BASE = '- alpha\n- beta\n- gamma\n';

type CaretLabel =
  | 'first-item-start'
  | 'first-item-mid'
  | 'first-item-end'
  | 'mid-item-mid'
  | 'last-item-end';

const CARETS: Array<{ label: CaretLabel; item: number; at: 'start' | 'mid' | 'end' }> = [
  { label: 'first-item-start', item: 0, at: 'start' },
  { label: 'first-item-mid', item: 0, at: 'mid' },
  { label: 'first-item-end', item: 0, at: 'end' },
  { label: 'mid-item-mid', item: 1, at: 'mid' },
  { label: 'last-item-end', item: 2, at: 'end' },
];

interface MixedCase {
  label: string;
  payloadMd: string;
  /** Expected serialized doc (trimEnd-compared) per caret position. */
  expected: Record<CaretLabel, string>;
  /** Expected top-level node types replacing the original list. */
  segments: Record<CaretLabel, string[]>;
}

const MIXED_PAYLOADS: MixedCase[] = [
  {
    label: 'heading+list',
    payloadMd: '## Section\n\n- one\n- two\n',
    expected: {
      'first-item-start': '## Section\n\n- one\n- two\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n\n## Section\n\n- one\n- two\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n\n## Section\n\n- one\n- two\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n\n## Section\n\n- one\n- two\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n\n## Section\n\n- one\n- two',
    },
    segments: {
      'first-item-start': ['heading', 'list'],
      'first-item-mid': ['list', 'heading', 'list'],
      'first-item-end': ['list', 'heading', 'list'],
      'mid-item-mid': ['list', 'heading', 'list'],
      'last-item-end': ['list', 'heading', 'list'],
    },
  },
  {
    label: 'paragraph+list',
    payloadMd: 'Intro para\n\n- one\n- two\n',
    expected: {
      'first-item-start': 'Intro para\n\n- one\n- two\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n\nIntro para\n\n- one\n- two\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n\nIntro para\n\n- one\n- two\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n\nIntro para\n\n- one\n- two\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n\nIntro para\n\n- one\n- two',
    },
    segments: {
      'first-item-start': ['paragraph', 'list'],
      'first-item-mid': ['list', 'paragraph', 'list'],
      'first-item-end': ['list', 'paragraph', 'list'],
      'mid-item-mid': ['list', 'paragraph', 'list'],
      'last-item-end': ['list', 'paragraph', 'list'],
    },
  },
  {
    label: 'list+heading',
    payloadMd: '- one\n- two\n\n## Section\n',
    expected: {
      'first-item-start': '- one\n- two\n\n## Section\n\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n- one\n- two\n\n## Section\n\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n- one\n- two\n\n## Section\n\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n- one\n- two\n\n## Section\n\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n- one\n- two\n\n## Section',
    },
    segments: {
      'first-item-start': ['list', 'heading', 'list'],
      'first-item-mid': ['list', 'heading', 'list'],
      'first-item-end': ['list', 'heading', 'list'],
      'mid-item-mid': ['list', 'heading', 'list'],
      'last-item-end': ['list', 'heading'],
    },
  },
  {
    label: 'two-headings',
    payloadMd: '## A\n\n## B\n',
    expected: {
      'first-item-start': '## A\n\n## B\n\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n\n## A\n\n## B\n\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n\n## A\n\n## B\n\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n\n## A\n\n## B\n\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n\n## A\n\n## B',
    },
    segments: {
      'first-item-start': ['heading', 'heading', 'list'],
      'first-item-mid': ['list', 'heading', 'heading', 'list'],
      'first-item-end': ['list', 'heading', 'heading', 'list'],
      'mid-item-mid': ['list', 'heading', 'heading', 'list'],
      'last-item-end': ['list', 'heading', 'heading'],
    },
  },
  {
    label: 'codeblock+list',
    payloadMd: '```js\ncode();\n```\n\n- one\n',
    expected: {
      'first-item-start': '```js\ncode();\n```\n\n- one\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n\n```js\ncode();\n```\n\n- one\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n\n```js\ncode();\n```\n\n- one\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n\n```js\ncode();\n```\n\n- one\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n\n```js\ncode();\n```\n\n- one',
    },
    segments: {
      'first-item-start': ['codeBlock', 'list'],
      'first-item-mid': ['list', 'codeBlock', 'list'],
      'first-item-end': ['list', 'codeBlock', 'list'],
      'mid-item-mid': ['list', 'codeBlock', 'list'],
      'last-item-end': ['list', 'codeBlock', 'list'],
    },
  },
  {
    label: 'lone-heading',
    payloadMd: '## Section\n',
    expected: {
      'first-item-start': '## Section\n\n- alpha\n- beta\n- gamma',
      'first-item-mid': '- al\n\n## Section\n\n- pha\n- beta\n- gamma',
      'first-item-end': '- alpha\n\n## Section\n\n- beta\n- gamma',
      'mid-item-mid': '- alpha\n- be\n\n## Section\n\n- ta\n- gamma',
      'last-item-end': '- alpha\n- beta\n- gamma\n\n## Section',
    },
    segments: {
      'first-item-start': ['heading', 'list'],
      'first-item-mid': ['list', 'heading', 'list'],
      'first-item-end': ['list', 'heading', 'list'],
      'mid-item-mid': ['list', 'heading', 'list'],
      'last-item-end': ['list', 'heading'],
    },
  },
];

function caretPos(editor: Editor, item: number, at: 'start' | 'mid' | 'end'): number {
  const r = itemParaRange(editor.state.doc, item);
  return at === 'start' ? r.start : at === 'end' ? r.end : Math.floor((r.start + r.end) / 2);
}

describe('matrix: mixed payload x caret position (Branch B markdown-first)', () => {
  for (const payload of MIXED_PAYLOADS) {
    for (const caret of CARETS) {
      test(`${payload.label} @ ${caret.label}`, () => {
        const editor = mountEditor(BASE);
        setCaret(editor, caretPos(editor, caret.item, caret.at));
        const topLevelBefore = topLevelTypes(editor.state.doc);
        expect(paste(editor, 'B', { md: payload.payloadMd })).toBe(true);
        // The original single top-level list is replaced by the expected
        // segment sequence; anything after it (e.g. a trailing empty
        // paragraph from parsing BASE) is untouched.
        expect(topLevelTypes(editor.state.doc)).toEqual([
          ...payload.segments[caret.label],
          ...topLevelBefore.slice(1),
        ]);
        if (payload.payloadMd.includes('##')) {
          expect(headingPlacement(editor.state.doc)).toBe('top-level');
        }
        expect(serialize(editor).trimEnd()).toBe(payload.expected[caret.label]);
      });
    }
  }
});

describe('all-list control keeps the #609 sibling splice', () => {
  for (const caret of CARETS) {
    test(`all-list @ ${caret.label}`, () => {
      const editor = mountEditor(BASE);
      setCaret(editor, caretPos(editor, caret.item, caret.at));
      const topLevelBefore = topLevelTypes(editor.state.doc);
      expect(paste(editor, 'B', { md: '- one\n- two\n' })).toBe(true);
      // Pure-list payloads splice as item siblings inside the original list;
      // nothing escapes to doc level (exact shapes are pinned by
      // handle-paste.list-placement.test.ts).
      expect(topLevelTypes(editor.state.doc)).toEqual(topLevelBefore);
    });
  }
});

describe('paste flavor variation (heading+list @ mid-item-mid)', () => {
  const HTML = '<h2>Section</h2><ul><li>one</li><li>two</li></ul>';
  const EXPECTED = '- alpha\n- be\n\n## Section\n\n- one\n- two\n- ta\n- gamma';
  for (const flavor of ['B', 'E', 'D'] as const) {
    test(`flavor ${flavor}`, () => {
      const editor = mountEditor(BASE);
      setCaret(editor, caretPos(editor, 1, 'mid'));
      expect(paste(editor, flavor, { md: '## Section\n\n- one\n- two\n', html: HTML })).toBe(true);
      // B, E, and D all funnel through applyJsonSlice, so the placement fix
      // applies uniformly across flavors.
      expect(headingPlacement(editor.state.doc)).toBe('top-level');
      expect(serialize(editor).trimEnd()).toBe(EXPECTED);
    });
  }
});

describe('nested caret escapes to doc level', () => {
  test('heading+list at a nested-item caret', () => {
    const editor = mountEditor('- alpha\n  - child\n- beta\n');
    // item index 1 is the nested "child" item in doc order
    setCaret(editor, caretPos(editor, 1, 'mid'));
    expect(paste(editor, 'B', { md: '## Section\n\n- one\n' })).toBe(true);
    // The heading escapes the whole nesting stack to doc level. The remainder
    // of the split nested item ("ild") lifts to the top list level rather
    // than minting an empty parent bullet.
    expect(headingPlacement(editor.state.doc)).toBe('top-level');
    expect(serialize(editor).trimEnd()).toBe(
      '- alpha\n  - ch\n\n## Section\n\n- one\n- ild\n- beta',
    );
  });

  test('lone heading at a nested-item caret', () => {
    const editor = mountEditor('- alpha\n  - child\n- beta\n');
    setCaret(editor, caretPos(editor, 1, 'mid'));
    expect(paste(editor, 'B', { md: '## Section\n' })).toBe(true);
    expect(headingPlacement(editor.state.doc)).toBe('top-level');
    expect(serialize(editor).trimEnd()).toBe('- alpha\n  - ch\n\n## Section\n\n- ild\n- beta');
  });
});

describe('controls', () => {
  test('same payload at a top-level paragraph caret places heading top-level', () => {
    const editor = mountEditor('plain intro\n');
    setCaret(editor, 3);
    expect(paste(editor, 'B', { md: '## Section\n\n- one\n- two\n' })).toBe(true);
    expect(headingPlacement(editor.state.doc)).toBe('top-level');
  });

  test('dispatcher no longer matches the closed-slice swallow output', () => {
    const payload = '## Section\n\n- one\n- two\n';
    const viaDispatcher = mountEditor(BASE);
    setCaret(viaDispatcher, caretPos(viaDispatcher, 1, 'mid'));
    paste(viaDispatcher, 'B', { md: payload });

    // Direct closed-slice replaceSelection is the swallow mechanism: PM's
    // fitter legally nests the payload inside the target item because
    // listItem admits every block type. The placement layer (not the schema)
    // is what routes around it, so the raw mechanism still swallows while
    // the dispatcher splits.
    const direct = mountEditor(BASE);
    setCaret(direct, caretPos(direct, 1, 'mid'));
    const node = direct.state.schema.nodeFromJSON(mdManager.parse(payload) as JSONContent);
    direct.view.dispatch(direct.state.tr.replaceSelection(node.slice(0, node.content.size)));

    expect(headingPlacement(direct.state.doc)).toBe('inside-list');
    expect(serialize(viaDispatcher)).not.toBe(serialize(direct));
    expect(serialize(viaDispatcher).trimEnd()).toBe(
      '- alpha\n- be\n\n## Section\n\n- one\n- two\n- ta\n- gamma',
    );
  });
});
