/**
 * A block jsxComponent inside a table cell — the confirmed-lossy serialize path,
 * plus the insert-time gate that now keeps this client's owned routes from
 * producing it.
 *
 * A cell's PM schema is `block+` and a jsxComponent is `group: block`, so a
 * component is schema-valid inside a cell. But a GFM cell is phrasing-only on one
 * physical line, so the PM->markdown serializer flattens a cell's block content
 * (`flattenCellBlocks`, packages/core/src/markdown/table-cell-flatten.ts). A
 * jsxComponent's mdast form is an `mdxJsxFlowElement` whose name, props, and
 * source spelling live outside the `children`/`value` the flattener can project,
 * so a component in a cell is dropped whole and only a
 * `table-cell-flatten-dropped-block` diagnostic marks the loss.
 *
 * The first block PINS that serialize-side drop end to end on a component-in-cell
 * doc built directly. Direct construction is deliberate: the owned insertion
 * routes (paste, slash, drop, insertContent) now refuse this state at the
 * transaction boundary, so paste can no longer reach it. The state stays
 * reachable from an un-owned surface — a remote peer whose raw CRDT update spells
 * a component in a cell — which the gate deliberately exempts (rejecting a
 * CRDT-origin transaction would desync this client's view from the shared doc).
 * That peer's state still flows through this serializer, so the drop
 * characterization still matters. It is a characterization of reality, not a
 * target; preserving a component's source spelling in a cell instead of dropping
 * it is a serialize-time product decision, and if that fix lands these
 * expectations flip.
 *
 * The second block pins the reachability change itself: pasting a component at a
 * cell caret through the real gated editor leaves the doc unchanged.
 *
 * The serialize pins need no editor — they build the doc and call the serializer
 * directly. The gate assertion mounts a real TipTap editor over jsdom globals so
 * the paste runs the production dispatcher into the gate's filterTransaction.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { CellInsertionGate } from '../../src/editor/extensions/cell-insertion-gate';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { mdManager, schema } from './test-harness';

// The paste dispatcher pulls the degrade-path toast (sonner) into its import
// graph; stub it so module load stays inert. The gate's no-op path never
// degrades, so the stub is never invoked. The dispatcher factory is
// dynamic-imported in beforeAll so the stub is registered before its module
// graph evaluates.
mock.module('sonner', () => ({ toast: { error: mock(() => {}) } }));

// Bound by the beforeAll dynamic import, after the sonner stub is registered.
let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;

/** The structured diagnostic `flattenCellBlocks` emits for a content-losing drop. */
const DROP_EVENT = 'table-cell-flatten-dropped-block';

/** A 2x2 GFM table: header row (a,b), one data row (c,d). */
const TABLE_MD = '| a | b |\n| - | - |\n| c | d |\n';

/** Self-closing component: schema-valid in a cell, childless, carries a prop. */
const SELF_CLOSING_COMPONENT_MD = '<CustomWidget foo="bar" />';
/** Component with an interior body — blank-line-wrapped so it parses to a block. */
const INTERIOR_COMPONENT_MD = '<CustomWidget>\n\ninside\n\n</CustomWidget>\n';

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

/** The single jsxComponent node in `md`'s parse, as JSON (throws if absent). */
function parseComponentJson(md: string): JSONContent {
  const parsed = mdManager.parse(md) as JSONContent;
  let found: JSONContent | null = null;
  const walk = (node: JSONContent): void => {
    if (found) return;
    if (node.type === 'jsxComponent') {
      found = node;
      return;
    }
    node.content?.forEach(walk);
  };
  walk(parsed);
  if (!found) throw new Error(`no jsxComponent parsed from markdown: ${md}`);
  return found;
}

/**
 * Build the table doc with `componentMd`'s component appended into the first data
 * cell (after the intact "c" paragraph), directly — the un-owned-surface state a
 * remote peer's raw CRDT update can still spell. Preserving the "c" phrasing lets
 * the serialize oracle stay "component contributed zero bytes → output === the
 * untouched table".
 */
function tableDocWithComponentInFirstCell(componentMd: string): PmNode {
  const json = mdManager.parse(TABLE_MD) as JSONContent;
  const component = parseComponentJson(componentMd);
  let injected = false;
  const walk = (node: JSONContent): void => {
    if (injected) return;
    if (node.type === 'tableCell') {
      node.content = [...(node.content ?? []), component];
      injected = true;
      return;
    }
    node.content?.forEach(walk);
  };
  walk(json);
  if (!injected) throw new Error('parsed table had no tableCell to inject into');
  return schema.nodeFromJSON(json);
}

/** The first jsxComponent that is a descendant of a tableCell, or null. */
function componentInCell(doc: PmNode): PmNode | null {
  let found: PmNode | null = null;
  doc.descendants((node, _pos, parent) => {
    if (found) return false;
    if (node.type.name === 'jsxComponent' && parent?.type.name === 'tableCell') {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

/** Count of jsxComponent nodes anywhere in `doc`. */
function countComponentsAnywhere(doc: PmNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') count += 1;
    return true;
  });
  return count;
}

/** Serialize `doc`, capturing every `console.warn` line emitted during the run. */
function serializeCapturingWarns(doc: PmNode): { md: string; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    return { md: mdManager.serialize(doc.toJSON()), warns };
  } finally {
    console.warn = orig;
  }
}

// ─── Gated-editor helpers (second block) ───

const editors: Editor[] = [];
let restoreDomGlobals: (() => void) | null = null;

/** Mount a real editor carrying the app's insertion gate over the core schema. */
function mountGatedEditor(content: string | JSONContent): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({
    element: host,
    content,
    extensions: [...sharedExtensions, CellInsertionGate],
  });
  editors.push(editor);
  return editor;
}

/** Run the real WYSIWYG paste dispatcher against a mounted editor's view. */
function pasteInto(editor: Editor, data: Record<string, string>): boolean {
  return createHandlePaste({ mdManager })(editor.view, fakeDT(data));
}

/** Caret position inside the first data cell's paragraph text. */
function firstDataCellCaret(editor: Editor): number {
  let cellPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (cellPos === -1 && node.type.name === 'tableCell') {
      cellPos = pos;
      return false;
    }
    return true;
  });
  if (cellPos < 0) throw new Error('seed table has no tableCell');
  const caret = cellPos + 2; // cell open +1 → paragraph, +2 → paragraph text
  expect(editor.state.doc.resolve(caret).parent.type.name).toBe('paragraph');
  return caret;
}

let origWarn: typeof console.warn;
beforeAll(async () => {
  restoreDomGlobals = installDomGlobals();
  ({ createHandlePaste } = await import('../../src/editor/clipboard/handle-paste.ts'));
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});
beforeEach(() => {
  origWarn = console.warn;
});
afterEach(() => {
  console.warn = origWarn;
  while (editors.length > 0) editors.pop()?.destroy();
});

describe('a component in a table cell drops on serialize', () => {
  // Serializing the untouched table is the oracle for "the component
  // contributed nothing": a total drop makes the built-doc output
  // byte-identical to this, independent of table formatting details.
  const baselineMd = mdManager.serialize(schema.nodeFromJSON(mdManager.parse(TABLE_MD)).toJSON());

  test('a self-closing component in a cell serializes to nothing plus a drop warn', () => {
    const doc = tableDocWithComponentInFirstCell(SELF_CLOSING_COMPONENT_MD);

    // Reachability: the component genuinely sits inside the cell.
    const comp = componentInCell(doc);
    expect(comp?.attrs.componentName).toBe('CustomWidget');
    expect(comp?.childCount).toBe(0);

    const { md, warns } = serializeCapturingWarns(doc);

    // Loss: the name and props are gone from the serialized markdown.
    expect(md).not.toContain('CustomWidget');
    expect(md).not.toContain('foo');
    // The component contributed zero bytes — output equals the untouched table.
    expect(md).toBe(baselineMd);
    // Surrounding cells survive, so the drop is scoped, not a table-wide loss.
    expect(md).toContain('| c | d |');

    const drops = warns.map((w) => tryParseDrop(w)).filter((d): d is DropWarn => d !== null);
    expect(drops).toContainEqual({ event: DROP_EVENT, nodeType: 'mdxJsxFlowElement' });
  });

  test('a component with interior content in a cell drops the interior too', () => {
    const doc = tableDocWithComponentInFirstCell(INTERIOR_COMPONENT_MD);

    const comp = componentInCell(doc);
    expect(comp?.attrs.componentName).toBe('CustomWidget');
    // The interior body is present in the document before serialize...
    expect(comp?.textContent).toBe('inside');

    const { md, warns } = serializeCapturingWarns(doc);

    // ...yet the wrapper AND its interior vanish on serialize — the loss is not
    // limited to childless components.
    expect(md).not.toContain('CustomWidget');
    expect(md).not.toContain('inside');
    expect(md).toBe(baselineMd);

    const drops = warns.map((w) => tryParseDrop(w)).filter((d): d is DropWarn => d !== null);
    expect(drops).toContainEqual({ event: DROP_EVENT, nodeType: 'mdxJsxFlowElement' });
  });
});

describe('the owned WYSIWYG paste route refuses a component at a cell caret', () => {
  test('pasting a block component with the caret in a cell leaves the doc unchanged', () => {
    const editor = mountGatedEditor(mdManager.parse(TABLE_MD) as JSONContent);
    editor.commands.setTextSelection(firstDataCellCaret(editor));
    // Baseline captured after the caret lands: seating a selection after a
    // trailing table appends the schema's trailing paragraph in its own
    // (unfiltered) transaction, which is not what this assertion measures.
    const before = editor.state.doc;

    const handled = pasteInto(editor, { 'text/plain': SELF_CLOSING_COMPONENT_MD });

    // The dispatcher claims the paste (true) so no later branch re-inserts the
    // content; the gate filtered the insertion, so the doc is byte-identical and
    // no component landed anywhere.
    expect(handled).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(countComponentsAnywhere(editor.state.doc)).toBe(0);
  });
});

interface DropWarn {
  event: string;
  nodeType: string;
}

/** Parse a captured warn line as the structured drop diagnostic, or null. */
function tryParseDrop(line: string): DropWarn | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'event' in parsed &&
      'nodeType' in parsed &&
      typeof (parsed as Record<string, unknown>).event === 'string' &&
      typeof (parsed as Record<string, unknown>).nodeType === 'string'
    ) {
      const { event, nodeType } = parsed as { event: string; nodeType: string };
      return { event, nodeType };
    }
  } catch {
    // Non-JSON warn lines (unrelated diagnostics) are not drop events.
  }
  return null;
}
