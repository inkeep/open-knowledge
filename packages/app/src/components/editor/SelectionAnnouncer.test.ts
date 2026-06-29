
import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection } from '@tiptap/pm/state';
import type { BlockSelection } from '../../editor/extensions/selection-state-plugin.ts';
import { formatSelectionMessage } from './SelectionAnnouncer.tsx';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    jsxComponent: {
      group: 'block',
      content: 'block*',
      attrs: { componentName: { default: 'Unknown' } },
      selectable: true,
    },
    text: { group: 'inline' },
  },
  marks: {},
});

const p = (text = ''): ReturnType<Schema['node']> =>
  text ? schema.node('paragraph', null, [schema.text(text)]) : schema.node('paragraph');
const jsx = (
  componentName: string,
  children: ReturnType<Schema['node']>[] = [],
): ReturnType<Schema['node']> => schema.node('jsxComponent', { componentName }, children);

function makeEditor(doc: ReturnType<Schema['node']>) {
  const state = EditorState.create({
    doc,
    selection: NodeSelection.create(doc, 0),
  });
  // biome-ignore lint/suspicious/noExplicitAny: formatSelectionMessage only touches editor.state.doc.resolve
  return { state } as any;
}

describe('formatSelectionMessage', () => {
  test('returns empty string when blockSelection is null', () => {
    const editor = makeEditor(schema.node('doc', null, [p('hi')]));
    expect(formatSelectionMessage(editor, null)).toBe('');
  });

  test('returns empty string when ancestorChain is empty', () => {
    const editor = makeEditor(schema.node('doc', null, [p('hi')]));
    const sel: BlockSelection = {
      selectedBlockId: null,
      ancestorChain: [],
      selectionOrigin: 'programmatic',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    expect(formatSelectionMessage(editor, sel)).toBe('');
  });

  test('single-entry chain uses the registered descriptor label', () => {
    const editor = makeEditor(schema.node('doc', null, [jsx('Callout', [p('note')])]));
    const sel: BlockSelection = {
      selectedBlockId: 'b1',
      ancestorChain: [{ bridgeId: 'b1', componentName: 'Callout', pos: 0 }],
      selectionOrigin: 'pointer',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    const msg = formatSelectionMessage(editor, sel);
    expect(msg).toStartWith('Selected: ');
    expect(msg).toContain('Callout');
  });

  test('unregistered component surfaces componentName + "(unregistered)"', () => {
    const editor = makeEditor(schema.node('doc', null, [jsx('FooBar', [p('x')])]));
    const sel: BlockSelection = {
      selectedBlockId: 'b1',
      ancestorChain: [{ bridgeId: 'b1', componentName: 'FooBar', pos: 0 }],
      selectionOrigin: 'pointer',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    const msg = formatSelectionMessage(editor, sel);
    expect(msg).toBe('Selected: FooBar (unregistered)');
    expect(msg).not.toContain('*');
  });

  test('nested chain formats "N of M in Parent"', () => {
    const callout = jsx('Callout', [jsx('img'), jsx('img'), jsx('img')]);
    const doc = schema.node('doc', null, [callout]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 3) });
    // biome-ignore lint/suspicious/noExplicitAny: formatSelectionMessage only touches editor.state.doc.resolve
    const editor = { state } as any;
    const sel: BlockSelection = {
      selectedBlockId: 'image-b2',
      ancestorChain: [
        { bridgeId: 'callout-b1', componentName: 'Callout', pos: 0 },
        { bridgeId: 'image-b2', componentName: 'img', pos: 3 },
      ],
      selectionOrigin: 'pointer',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    const msg = formatSelectionMessage(editor, sel);
    expect(msg).toBe('Selected: Image, 2 of 3 in Callout');
  });

  test('nested chain with unresolvable pos falls back to no-index form', () => {
    const callout = jsx('Callout', [jsx('img')]);
    const doc = schema.node('doc', null, [callout]);
    const state = EditorState.create({ doc });
    // biome-ignore lint/suspicious/noExplicitAny: formatSelectionMessage only touches editor.state.doc.resolve
    const editor = { state } as any;
    const sel: BlockSelection = {
      selectedBlockId: 'image-b2',
      ancestorChain: [
        { bridgeId: 'callout-b1', componentName: 'Callout', pos: 0 },
        { bridgeId: 'image-b2', componentName: 'img', pos: 99999 },
      ],
      selectionOrigin: 'pointer',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    const msg = formatSelectionMessage(editor, sel);
    expect(msg).toBe('Selected: Image in Callout');
  });

  test('nested chain with unregistered innermost still identifies the component', () => {
    const callout = jsx('Callout', [jsx('FooBar')]);
    const doc = schema.node('doc', null, [callout]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 1) });
    // biome-ignore lint/suspicious/noExplicitAny: formatSelectionMessage only touches editor.state.doc.resolve
    const editor = { state } as any;
    const sel: BlockSelection = {
      selectedBlockId: 'foobar-b2',
      ancestorChain: [
        { bridgeId: 'callout-b1', componentName: 'Callout', pos: 0 },
        { bridgeId: 'foobar-b2', componentName: 'FooBar', pos: 1 },
      ],
      selectionOrigin: 'pointer',
      isDragging: false,
      rangeEncompassedBlockIds: new Set<string>(),
    };
    const msg = formatSelectionMessage(editor, sel);
    expect(msg).toContain('FooBar (unregistered)');
    expect(msg).toContain('in Callout');
  });
});
