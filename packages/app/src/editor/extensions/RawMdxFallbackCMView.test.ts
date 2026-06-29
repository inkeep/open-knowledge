
import { describe, expect, test } from 'bun:test';
import { EditorState as CMEditorState } from '@codemirror/state';
import type { EditorView as CMEditorView } from '@codemirror/view';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  computeChange,
  computeCMSelectionForwarding,
  shouldEscapeNestedCM,
  tryParseUpgrade,
} from './RawMdxFallbackCMView';

function makeCMView(doc: string, selPos: number | { anchor: number; head: number }): CMEditorView {
  const selection =
    typeof selPos === 'number'
      ? { anchor: selPos, head: selPos }
      : { anchor: selPos.anchor, head: selPos.head };
  const state = CMEditorState.create({ doc, selection });
  return { state } as unknown as CMEditorView;
}


const pmSchema = getSchema(sharedExtensions);

function fallbackNode(source: string): PMNode {
  return pmSchema.node(
    'rawMdxFallback',
    { reason: 'test fixture' },
    source ? [pmSchema.text(source)] : [],
  );
}

function docWithFallback(source: string): PMNode {
  return pmSchema.node('doc', null, [fallbackNode(source)]);
}

describe('computeChange', () => {
  test('returns null for identical strings', () => {
    expect(computeChange('hello', 'hello')).toBeNull();
  });

  test('returns null for empty identical strings', () => {
    expect(computeChange('', '')).toBeNull();
  });

  test('detects insert at end', () => {
    const change = computeChange('hello', 'hello world');
    expect(change).toEqual({ from: 5, to: 5, text: ' world' });
  });

  test('detects insert at beginning', () => {
    const change = computeChange('world', 'hello world');
    expect(change).toEqual({ from: 0, to: 0, text: 'hello ' });
  });

  test('detects insert in middle', () => {
    const change = computeChange('helloworld', 'hello world');
    expect(change).toEqual({ from: 5, to: 5, text: ' ' });
  });

  test('detects delete at end', () => {
    const change = computeChange('hello world', 'hello');
    expect(change).toEqual({ from: 5, to: 11, text: '' });
  });

  test('detects delete at beginning', () => {
    const change = computeChange('hello world', 'world');
    expect(change).toEqual({ from: 0, to: 6, text: '' });
  });

  test('detects delete in middle', () => {
    const change = computeChange('hello world', 'helloworld');
    expect(change).toEqual({ from: 5, to: 6, text: '' });
  });

  test('detects replacement', () => {
    const change = computeChange('hello world', 'hello there');
    expect(change).toEqual({ from: 6, to: 11, text: 'there' });
  });

  test('detects full replacement', () => {
    const change = computeChange('abc', 'xyz');
    expect(change).toEqual({ from: 0, to: 3, text: 'xyz' });
  });

  test('handles empty to non-empty', () => {
    const change = computeChange('', 'hello');
    expect(change).toEqual({ from: 0, to: 0, text: 'hello' });
  });

  test('handles non-empty to empty', () => {
    const change = computeChange('hello', '');
    expect(change).toEqual({ from: 0, to: 5, text: '' });
  });

  test('handles single character insert', () => {
    const change = computeChange('helo', 'hello');
    expect(change).toEqual({ from: 3, to: 3, text: 'l' });
  });

  test('handles single character delete', () => {
    const change = computeChange('hello', 'helo');
    expect(change).toEqual({ from: 3, to: 4, text: '' });
  });

  test('handles multiline content', () => {
    const old = '<Callout>\nfirst\n</Callout>';
    const neu = '<Callout>\nsecond\n</Callout>';
    const change = computeChange(old, neu);
    expect(change).toEqual({ from: 10, to: 15, text: 'second' });
  });

  test('1000 sequential computeChanges produce correct results', () => {
    let current = 'start';
    for (let i = 0; i < 1000; i++) {
      const next = `${current}${i}`;
      const change = computeChange(current, next);
      expect(change).not.toBeNull();
      const applied = current.slice(0, change?.from) + change?.text + current.slice(change?.to);
      expect(applied).toBe(next);
      current = next;
    }
  });
});

describe('shouldEscapeNestedCM', () => {
  test('char/Left: cursor at start → escape', () => {
    const view = makeCMView('hello', 0);
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(true);
  });
  test('char/Left: cursor mid-doc → no escape', () => {
    const view = makeCMView('hello', 3);
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(false);
  });
  test('char/Left: cursor at end → no escape (wrong direction)', () => {
    const view = makeCMView('hello', 5);
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(false);
  });

  test('char/Right: cursor at end → escape', () => {
    const view = makeCMView('hello', 5);
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(true);
  });
  test('char/Right: cursor mid-doc → no escape', () => {
    const view = makeCMView('hello', 3);
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(false);
  });
  test('char/Right: cursor at start → no escape (wrong direction)', () => {
    const view = makeCMView('hello', 0);
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(false);
  });

  test('line/Up: cursor on first line (col 3) → escape', () => {
    const view = makeCMView('hello\nworld\n!', 3);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(true);
  });
  test('line/Up: cursor on second line → no escape', () => {
    const view = makeCMView('hello\nworld\n!', 8);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(false);
  });

  test('line/Down: cursor on last line → escape', () => {
    const view = makeCMView('hello\nworld\n!', 13);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(true);
  });
  test('line/Down: cursor on middle line → no escape', () => {
    const view = makeCMView('hello\nworld\n!', 8);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(false);
  });

  test('non-empty selection at start → no escape (protect range expansion)', () => {
    const view = makeCMView('hello', { anchor: 0, head: 3 });
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(false);
  });
  test('non-empty selection at end → no escape', () => {
    const view = makeCMView('hello', { anchor: 3, head: 5 });
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(false);
  });

  test('empty doc: char/Left → escape', () => {
    const view = makeCMView('', 0);
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(true);
  });
  test('empty doc: char/Right → escape', () => {
    const view = makeCMView('', 0);
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(true);
  });
  test('empty doc: line/Up → escape', () => {
    const view = makeCMView('', 0);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(true);
  });
  test('empty doc: line/Down → escape', () => {
    const view = makeCMView('', 0);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(true);
  });

  test('single line: line/Up (col 2) → escape', () => {
    const view = makeCMView('hello', 2);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(true);
  });
  test('single line: line/Down (col 2) → escape', () => {
    const view = makeCMView('hello', 2);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(true);
  });
});

describe('computeCMSelectionForwarding', () => {
  const doc = docWithFallback('hello');
  const NODE_POS = 0;
  const NODE_SIZE = 7;
  const CM_DOC_LEN = 5; // "hello" → 5 chars

  describe('NodeSelection ON this exact node', () => {
    test('CM lacks focus → returns {kind: "focus"}', () => {
      const pmSel = NodeSelection.create(doc, NODE_POS);
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'focus' });
    });

    test('CM already has focus → returns {kind: "noop"} (avoid re-dispatch)', () => {
      const pmSel = NodeSelection.create(doc, NODE_POS);
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 2, head: 2 },
        cmHasFocus: true,
      });
      expect(action).toEqual({ kind: 'noop' });
    });
  });

  describe('NodeSelection on a different node', () => {
    test('PM selects a different rawMdxFallback → returns noop for this one', () => {
      const d = pmSchema.node('doc', null, [fallbackNode('first'), fallbackNode('second')]);
      const pmSel = NodeSelection.create(d, 7); // select second
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: 0, // test from the first's perspective
        nodeSize: 7,
        cmDocLen: 5,
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'noop' });
    });
  });

  describe("TextSelection inside this node's content range", () => {
    test('cursor at content start → returns selection {anchor:0, head:0}', () => {
      const pmSel = TextSelection.create(doc, 1); // nodeStart
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 3, head: 3 }, // CM currently elsewhere
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'selection', anchor: 0, head: 0 });
    });

    test('cursor at content end → returns selection at cmDocLen', () => {
      const pmSel = TextSelection.create(doc, 6); // nodeEnd
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'selection', anchor: 5, head: 5 });
    });

    test('range selection inside content → returns selection with both anchor/head offset', () => {
      const pmSel = TextSelection.create(doc, 2, 5); // "ell" range
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'selection', anchor: 1, head: 4 });
    });

    test('CM selection already matches + has focus → returns noop', () => {
      const pmSel = TextSelection.create(doc, 3); // middle of content
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 2, head: 2 }, // 3 - nodeStart(1) = 2
        cmHasFocus: true,
      });
      expect(action).toEqual({ kind: 'noop' });
    });

    test('CM selection matches but lacks focus → returns selection (to trigger focus)', () => {
      const pmSel = TextSelection.create(doc, 3);
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: CM_DOC_LEN,
        cmSel: { anchor: 2, head: 2 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'selection', anchor: 2, head: 2 });
    });
  });

  describe("TextSelection outside this node's content range", () => {
    const d2 = pmSchema.node('doc', null, [
      pmSchema.node('paragraph', null, [pmSchema.text('outside')]),
      fallbackNode('inside'),
    ]);

    test('PM selection in preceding paragraph → returns noop for fallback', () => {
      const pmSel = TextSelection.create(d2, 3); // inside paragraph
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: 9, // fallback position
        nodeSize: 8,
        cmDocLen: 6,
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'noop' });
    });
  });

  describe('Offset clamping (defense against stale PM range under concurrent edit)', () => {
    test('PM offset > cmDocLen → clamped to cmDocLen', () => {
      const pmSel = TextSelection.create(doc, 6);
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: NODE_POS,
        nodeSize: NODE_SIZE,
        cmDocLen: 3, // CM doc shorter than PM believes
        cmSel: { anchor: 0, head: 0 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'selection', anchor: 3, head: 3 });
    });

    test('PM anchor negative (synthetic) → clamped to 0', () => {
      const pmSel = TextSelection.create(doc, 1); // at nodeStart
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: 5, // nodeStart would be 6 → 1 - 6 = -5
        nodeSize: 3,
        cmDocLen: 10,
        cmSel: { anchor: 5, head: 5 },
        cmHasFocus: false,
      });
      expect(action).toEqual({ kind: 'noop' });
    });
  });
});


describe('tryParseUpgrade', () => {
  const upgradeSchema = getSchema(sharedExtensions);

  test('valid MDX for registered component → returns one-element array with that jsxComponent', () => {
    const source = '<Callout type="info">\n\nhello\n\n</Callout>';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0].type.name).toBe('jsxComponent');
    expect(result?.[0].attrs.componentName).toBe('Callout');
  });

  test('valid MDX for unregistered component → returns jsxComponent (caller handles wildcard)', () => {
    const source = '<UnknownWidget foo="bar">\n\nbody\n\n</UnknownWidget>';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0].type.name).toBe('jsxComponent');
    expect(result?.[0].attrs.componentName).toBe('UnknownWidget');
  });

  test('plain paragraph text → returns [paragraph]', () => {
    const source = 'just a paragraph';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result?.[0].type.name).toBe('paragraph');
  });

  test('tag mismatch → parse yields rawMdxFallback → returns null (no-op)', () => {
    const source = '<Foo>text</Bar>';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).toBeNull();
  });

  test('empty source → returns [empty paragraph]', () => {
    const source = '';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result?.[0].type.name).toBe('paragraph');
  });

  test('multi-block source (headings + paragraphs) → returns all blocks', () => {
    const source = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result?.[0].type.name).toBe('heading');
    expect(result?.[1].type.name).toBe('paragraph');
    expect(result?.[2].type.name).toBe('paragraph');
  });

  test('multi-block with one jsxComponent and one paragraph → returns both', () => {
    const source = '<Callout type="info">\n\nhello\n\n</Callout>\n\nExtra paragraph.';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0].type.name).toBe('jsxComponent');
    expect(result?.[0].attrs.componentName).toBe('Callout');
    expect(result?.[1].type.name).toBe('paragraph');
  });

  test('multi-block with one fallback among valid blocks → returns null', () => {
    const source = '# Valid heading\n\n<Foo>still broken</Bar>\n\nTrailing para.';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).toBeNull();
  });

  test('nested compound with valid MDX → returns [outer jsxComponent]', () => {
    const source = '<Cards>\n\n<Card title="Foo" />\n\n</Cards>';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0].type.name).toBe('jsxComponent');
    expect(result?.[0].attrs.componentName).toBe('Cards');
  });

  test('heading source → returns [heading]', () => {
    const source = '## A heading';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result?.[0].type.name).toBe('heading');
  });

  test('fenced code block → returns [code-like node]', () => {
    const source = '```typescript\nconst x = 1;\n```';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result?.[0].type.name).toMatch(/code/i);
  });

  test('schema.nodeFromJSON throw → returns null and logs structured event', () => {
    const throwingSchema = {
      nodeFromJSON(_json: unknown): never {
        throw new RangeError("Invalid content for node 'paragraph'");
      },
    } as unknown as typeof upgradeSchema;

    const originalWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const result = tryParseUpgrade('# Heading\n\nhello', throwingSchema);
      expect(result).toBeNull();
      expect(warnCalls.length).toBeGreaterThan(0);
      const event = warnCalls.find((c) => c.includes('raw-mdx-upgrade-failure'));
      expect(event).toBeDefined();
      expect(event).toContain('Invalid content for node');
    } finally {
      console.warn = originalWarn;
    }
  });
});
