/**
 * Unregistered component in a table cell — the confirmed-lossy serialize path.
 *
 * A table cell's PM schema is `block+` and a jsxComponent is `group: block`, so
 * an unregistered component is schema-valid inside a cell and reaches one through
 * the ordinary WYSIWYG paste route with no insert-time guard. But a GFM cell is
 * phrasing-only on one physical line, so the PM→markdown serializer flattens a
 * cell's block content (`flattenCellBlocks`, packages/core/src/markdown/
 * table-cell-flatten.ts). A jsxComponent's mdast form is an `mdxJsxFlowElement`
 * whose name, props, and source spelling live outside the `children`/`value`
 * the flattener can project, so a component in a cell is dropped whole and only
 * a `table-cell-flatten-dropped-block` diagnostic marks the loss.
 *
 * These tests PIN that current lossy behavior end to end — real paste dispatcher
 * places the component, real serializer drops it. This is a characterization of
 * reality, not a target. The loss is component-general (a registered component
 * flattens the same way); the unregistered slice is pinned here. Preserving a
 * component's source spelling in a cell instead of dropping it is a
 * serialize-time product decision; if that fix lands these expectations flip and
 * must be updated.
 *
 * No DOM: the dispatcher only touches `view.state`/`view.dispatch`, so a plain
 * object over a real EditorState reaches the production paste path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { mdManager, schema } from './test-harness';

// paste-failure-toast pulls in sonner; stub it so module load stays inert.
mock.module('sonner', () => ({ toast: { error: mock(() => {}) } }));

let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;
beforeEach(async () => {
  ({ createHandlePaste } = await import('../../src/editor/clipboard/handle-paste.ts'));
});

/** The structured diagnostic `flattenCellBlocks` emits for a content-losing drop. */
const DROP_EVENT = 'table-cell-flatten-dropped-block';

/** A 2x2 GFM table; the caret seeds into the first data cell (text "c"). */
const TABLE_MD = '| a | b |\n| - | - |\n| c | d |\n';

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

/** A view whose state is a real EditorState — dispatch applies for real, so the
 *  paste's `replaceSelection` runs PM's actual slice-fitting into the cell. */
function realStateView(initial: EditorState) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
    current: () => state,
  };
}

/** Seed the table doc with a collapsed caret inside the first data cell's text. */
function seedWithCellCaret(): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(TABLE_MD));
  const base = EditorState.create({ doc, schema });
  let cellPos = -1;
  base.doc.descendants((node, pos) => {
    if (cellPos === -1 && node.type.name === 'tableCell') {
      cellPos = pos;
      return false;
    }
    return true;
  });
  expect(cellPos).toBeGreaterThanOrEqual(0);
  // cellPos = cell open; +1 enters the cell paragraph; +2 lands in its text.
  const caret = cellPos + 2;
  expect(base.doc.resolve(caret).parent.type.name).toBe('paragraph');
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, caret)));
}

/** Paste `payload` (text/plain markdown) into the cell caret; return the doc. */
function pasteIntoCell(payload: string): PmNode {
  const view = realStateView(seedWithCellCaret());
  const handled = createHandlePaste({ mdManager })(
    view as never,
    fakeDT({ 'text/plain': payload }),
  );
  expect(handled).toBe(true);
  return view.current().doc;
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

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
});
afterEach(() => {
  console.warn = origWarn;
});

describe('unregistered component in a table cell drops on serialize', () => {
  // Serializing the untouched table is the oracle for "the component
  // contributed nothing": a total drop makes the pasted-doc output
  // byte-identical to this, independent of table formatting details.
  const baselineMd = mdManager.serialize(schema.nodeFromJSON(mdManager.parse(TABLE_MD)).toJSON());

  test('a self-closing component pastes into a cell then serializes to nothing + a drop warn', () => {
    const doc = pasteIntoCell('<CustomWidget foo="bar" />');

    // Reachability: the component genuinely reached the cell (no insert guard).
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

  test('a component WITH interior content in a cell drops the interior too', () => {
    const doc = pasteIntoCell('<CustomWidget>\n\ninside\n\n</CustomWidget>\n');

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
