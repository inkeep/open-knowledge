import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { CellInsertionGate } from '../../src/editor/extensions/cell-insertion-gate';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { mdManager, schema } from './test-harness';

vi.doMock('sonner', () => ({ toast: { error: vi.fn(() => {}) } }));

let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;

const DROP_EVENT = 'table-cell-flatten-dropped-block';

const TABLE_MD = '| a | b |\n| - | - |\n| c | d |\n';

const SELF_CLOSING_COMPONENT_MD = '<CustomWidget foo="bar" />';
const INTERIOR_COMPONENT_MD = '<CustomWidget>\n\ninside\n\n</CustomWidget>\n';

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

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

function countComponentsAnywhere(doc: PmNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') count += 1;
    return true;
  });
  return count;
}

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

const editors: Editor[] = [];
let restoreDomGlobals: (() => void) | null = null;

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

function pasteInto(editor: Editor, data: Record<string, string>): boolean {
  return createHandlePaste({ mdManager })(editor.view, fakeDT(data));
}

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
  const caret = cellPos + 2;
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
  const baselineMd = mdManager.serialize(schema.nodeFromJSON(mdManager.parse(TABLE_MD)).toJSON());

  test('a self-closing component in a cell serializes to nothing plus a drop warn', () => {
    const doc = tableDocWithComponentInFirstCell(SELF_CLOSING_COMPONENT_MD);

    const comp = componentInCell(doc);
    expect(comp?.attrs.componentName).toBe('CustomWidget');
    expect(comp?.childCount).toBe(0);

    const { md, warns } = serializeCapturingWarns(doc);

    expect(md).not.toContain('CustomWidget');
    expect(md).not.toContain('foo');
    expect(md).toBe(baselineMd);
    expect(md).toContain('| c | d |');

    const drops = warns.map((w) => tryParseDrop(w)).filter((d): d is DropWarn => d !== null);
    expect(drops).toContainEqual({ event: DROP_EVENT, nodeType: 'mdxJsxFlowElement' });
  });

  test('a component with interior content in a cell drops the interior too', () => {
    const doc = tableDocWithComponentInFirstCell(INTERIOR_COMPONENT_MD);

    const comp = componentInCell(doc);
    expect(comp?.attrs.componentName).toBe('CustomWidget');
    expect(comp?.textContent).toBe('inside');

    const { md, warns } = serializeCapturingWarns(doc);

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
    const before = editor.state.doc;

    const handled = pasteInto(editor, { 'text/plain': SELF_CLOSING_COMPONENT_MD });

    expect(handled).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(countComponentsAnywhere(editor.state.doc)).toBe(0);
  });
});

interface DropWarn {
  event: string;
  nodeType: string;
}

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
  } catch {}
  return null;
}
