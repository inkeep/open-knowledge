/**
 * Nested CodeMirror sync math tests.
 *
 * Tests the `computeChange` function that computes minimal string diffs
 * for PM→CM and CM→PM synchronization, the `shouldEscapeNestedCM` boundary
 * predicate that drives arrow-key escape from nested CM to outer PM, and
 * `computeCMSelectionForwarding` — the PM→CM selection mirror decision
 * (Precedent #31 "Selection state as typed PM PluginState").
 */

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

/**
 * Build a minimal CM EditorView stand-in that satisfies
 * `shouldEscapeNestedCM`'s surface: `.state.selection.main` +
 * `.state.doc.lineAt` + `.state.doc.length`. We use a real CM `EditorState`
 * so `doc.lineAt` returns the true CM `Line` shape — no mocking the shape.
 */
function makeCMView(doc: string, selPos: number | { anchor: number; head: number }): CMEditorView {
  const selection =
    typeof selPos === 'number'
      ? { anchor: selPos, head: selPos }
      : { anchor: selPos.anchor, head: selPos.head };
  const state = CMEditorState.create({ doc, selection });
  // We never mount the view — only `.state` is read by shouldEscapeNestedCM.
  return { state } as unknown as CMEditorView;
}

// ── PM fixtures for computeCMSelectionForwarding ─────────────────────────

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

  // Loop prevention stress test
  test('1000 sequential computeChanges produce correct results', () => {
    let current = 'start';
    for (let i = 0; i < 1000; i++) {
      const next = `${current}${i}`;
      const change = computeChange(current, next);
      expect(change).not.toBeNull();
      // Apply the change to verify correctness
      const applied = current.slice(0, change?.from) + change?.text + current.slice(change?.to);
      expect(applied).toBe(next);
      current = next;
    }
  });
});

describe('shouldEscapeNestedCM', () => {
  // char × Left (dir=-1): escape only when cursor is at offset 0
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

  // char × Right (dir=+1): escape only when cursor is at doc end
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

  // line × Up (dir=-1): escape only when cursor is on the first line
  test('line/Up: cursor on first line (col 3) → escape', () => {
    const view = makeCMView('hello\nworld\n!', 3);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(true);
  });
  test('line/Up: cursor on second line → no escape', () => {
    const view = makeCMView('hello\nworld\n!', 8);
    expect(shouldEscapeNestedCM(view, 'line', -1)).toBe(false);
  });

  // line × Down (dir=+1): escape only when cursor is on the last line
  test('line/Down: cursor on last line → escape', () => {
    const view = makeCMView('hello\nworld\n!', 13);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(true);
  });
  test('line/Down: cursor on middle line → no escape', () => {
    const view = makeCMView('hello\nworld\n!', 8);
    expect(shouldEscapeNestedCM(view, 'line', 1)).toBe(false);
  });

  // Non-empty selection never escapes — prevents accidentally blowing
  // away a shift-arrow range expansion that crosses the boundary
  test('non-empty selection at start → no escape (protect range expansion)', () => {
    const view = makeCMView('hello', { anchor: 0, head: 3 });
    expect(shouldEscapeNestedCM(view, 'char', -1)).toBe(false);
  });
  test('non-empty selection at end → no escape', () => {
    const view = makeCMView('hello', { anchor: 3, head: 5 });
    expect(shouldEscapeNestedCM(view, 'char', 1)).toBe(false);
  });

  // Empty document: cursor is simultaneously at start AND end — escapes
  // in whichever direction is requested. This matches the canonical
  // pattern: an empty fallback block should not trap the caret.
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

  // Single-line doc: Up/Down both escape because first line == last line
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
  // Canonical fixture: doc containing one rawMdxFallback with source "hello".
  //   fallback opens at pos 0, text content at pos 1..5, closes at pos 6
  //   nodeSize = 7, nodeStart = 1, nodeEnd = 6
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
    // Two-fallback doc — select the SECOND one, then test the helper for the FIRST.
    // <fallback>first</fallback><fallback>second</fallback>
    //   first:  pos 0..7  (nodeSize 7, text at 1..6)
    //   second: pos 7..15 (nodeSize 8, text at 8..14)
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
    // Multi-block doc: <p>outside</p><fallback>inside</fallback>
    //   paragraph: pos 0..9 (open at 0, text 1..7, close at 8, after at 9)
    //   fallback:  pos 9..17 (nodeSize 8, text 10..15)
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
      // PM thinks content is at pos 6 (nodeEnd), but CM doc was just
      // shrunk to 3 chars — the forwarded offset must clamp to 3.
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
      // Synthetic stale state: PM sel.anchor - nodeStart < 0.
      // Using a nodePos that makes nodeStart > pmSel.anchor in math.
      const pmSel = TextSelection.create(doc, 1); // at nodeStart
      const action = computeCMSelectionForwarding({
        pmSel,
        nodePos: 5, // nodeStart would be 6 → 1 - 6 = -5
        nodeSize: 3,
        cmDocLen: 10,
        cmSel: { anchor: 5, head: 5 },
        cmHasFocus: false,
      });
      // pmSel.from (=1) < nodeStart (=6), so falls through to noop
      expect(action).toEqual({ kind: 'noop' });
    });
  });
});

// ── tryParseUpgrade — on-blur re-parse decision ──────────────────────────

describe('tryParseUpgrade', () => {
  // The real schema — same one the editor uses at runtime. `tryParseUpgrade`
  // routes through `MarkdownManager.parseWithFallback` + `schema.nodeFromJSON`
  // so we need the full parse pipeline, not a synthetic schema.
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
    // tryParseUpgrade's contract is "parse produced no rawMdxFallback in
    // the result"; it does NOT know about the descriptor registry. The
    // caller (the CM blur handler in RawMdxFallbackCMView) returns this
    // as-is; the upgraded jsxComponent's NodeView (JsxComponentView)
    // then wildcard-auto-converts back to rawMdxFallback via its own
    // mount effect.
    // Double-conversion is wasteful but harmless — catching
    // unregistered-name here would couple this helper to the registry
    // and tryParseUpgrade becomes a decision primitive, not a parse
    // primitive. Keep it simple.
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
    // Classic parse-error path that would re-produce a rawMdxFallback.
    // No-op: preserving the existing rawMdxFallback node identity beats
    // swapping in a fresh one (Precedent #10 Item-preservation).
    const source = '<Foo>text</Bar>';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).toBeNull();
  });

  test('empty source → returns [empty paragraph]', () => {
    // `mdManager.parseWithFallback("")` short-circuits to a doc with a
    // single empty paragraph — that's a valid upgrade target. Acceptable
    // UX: if user erases all content, the fallback upgrades to a normal
    // empty paragraph.
    const source = '';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result?.[0].type.name).toBe('paragraph');
  });

  test('multi-block source (headings + paragraphs) → returns all blocks', () => {
    // User-reported bug scenario: `parseWithFallback`'s R6
    // recovery often absorbs adjacent blocks into one fallback when a
    // broken MDX tag's scope isn't cleanly bounded. After the user
    // fixes the broken tag, the source parses to MULTIPLE valid blocks.
    // Single-block-only behavior would return null and leave the
    // fallback in place — breaking the user's "I fixed the thing;
    // upgrade the whole block" mental model. Multi-block upgrades are
    // the correct fix.
    const source = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result?.[0].type.name).toBe('heading');
    expect(result?.[1].type.name).toBe('paragraph');
    expect(result?.[2].type.name).toBe('paragraph');
  });

  test('multi-block with one jsxComponent and one paragraph → returns both', () => {
    // The exact shape of the user-reported bug: fallback content
    // contains a fixed-tag jsxComponent followed by adjacent prose.
    const source = '<Callout type="info">\n\nhello\n\n</Callout>\n\nExtra paragraph.';
    const result = tryParseUpgrade(source, upgradeSchema);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0].type.name).toBe('jsxComponent');
    expect(result?.[0].attrs.componentName).toBe('Callout');
    expect(result?.[1].type.name).toBe('paragraph');
  });

  test('multi-block with one fallback among valid blocks → returns null', () => {
    // If ANY sub-span is still invalid (yields a rawMdxFallback after
    // re-parse), the user hasn't finished fixing — preserve the
    // existing fallback so they can continue editing.
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
    // PM's code-block-like node (may be named codeBlock, codeBlockHighlighted, etc.)
    expect(result?.[0].type.name).toMatch(/code/i);
  });

  test('schema.nodeFromJSON throw → returns null and logs structured event', () => {
    // Regression: `schema.nodeFromJSON` CAN throw on
    // schema-drift edges ("Invalid content for node ..."). Previously the
    // throw escaped tryParseUpgrade and was swallowed by CodeMirror's
    // updateListener catch — user blurred, saw no change, had no signal.
    // The helper now catches, logs `raw-mdx-upgrade-failure`, returns null
    // (preserving the existing fallback so the user can keep editing).
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
