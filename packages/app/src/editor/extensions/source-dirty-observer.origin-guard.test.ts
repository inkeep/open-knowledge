import { getSchema } from '@tiptap/core';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { PROJECTION_REMOTE_APPLY_META } from './autonomous-fragment-edit';
import { sharedExtensions } from './shared';
import { sourceDirtyPluginKey } from './source-dirty-observer';
import { applyWithAppend, getSourceDirtyPlugin } from './source-dirty-observer.test-helper';

const schema = getSchema(sharedExtensions);

function buildInitialState(plugin: Plugin): EditorState {
  const doc = schema.node('doc', null, [
    schema.node(
      'jsxComponent',
      {
        content: '',
        componentName: 'Callout',
        kind: 'element',
        attributes: [],
        sourceRaw: '<Callout title="A">\n\nA body\n\n</Callout>',
        sourceDirty: false,
        props: { title: 'A' },
      },
      [schema.node('paragraph', null, [schema.text('A body')])],
    ),
    schema.node(
      'jsxComponent',
      {
        content: '',
        componentName: 'Callout',
        kind: 'element',
        attributes: [],
        sourceRaw: '<Callout title="B">\n\nB body\n\n</Callout>',
        sourceDirty: false,
        props: { title: 'B' },
      },
      [schema.node('paragraph', null, [schema.text('B body')])],
    ),
  ]);

  return EditorState.create({ schema, doc, plugins: [plugin] });
}

function firstComponentPos(state: EditorState): number {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (node.type.name === 'jsxComponent') pos = p;
  });
  if (pos === -1) throw new Error('No jsxComponent in doc');
  return pos;
}

function isDirty(state: EditorState, pos: number): boolean {
  const node = state.doc.nodeAt(pos);
  if (!node) throw new Error(`No node at pos ${pos}`);
  return Boolean(node.attrs.sourceDirty);
}

function componentPositions(state: EditorState): number[] {
  const positions: number[] = [];
  state.doc.descendants((node, p) => {
    if (node.type.name === 'jsxComponent') positions.push(p);
  });
  return positions;
}

function editInteriorText(state: EditorState, text: string, remote = false): EditorState {
  const innerTextPos = firstComponentPos(state) + 2;
  return applyWithAppend(state, (tr) => {
    if (remote) tr.setMeta(PROJECTION_REMOTE_APPLY_META, true);
    return tr.insertText(text, innerTextPos);
  });
}

describe('SourceDirtyObserver origin guard', () => {
  test('user-intent prop edit marks only the mutated jsxComponent dirty', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);
    const secondPos = targetPos + (initial.doc.nodeAt(targetPos)?.nodeSize ?? 0);

    expect(isDirty(initial, targetPos)).toBe(false);
    expect(isDirty(initial, secondPos)).toBe(false);

    const next = applyWithAppend(initial, (tr) => {
      const node = initial.doc.nodeAt(targetPos);
      if (!node) throw new Error('Target vanished');
      return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'A-new' } });
    });

    expect(isDirty(next, targetPos)).toBe(true);
    expect(isDirty(next, secondPos)).toBe(false);
  });

  test('a remote re-projection does NOT mark dirty', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    const next = applyWithAppend(initial, (tr) => {
      const node = initial.doc.nodeAt(targetPos);
      if (!node) throw new Error('Target vanished');
      tr.setMeta(PROJECTION_REMOTE_APPLY_META, true);
      return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'A-remote' } });
    });

    const nodeAfter = next.doc.nodeAt(targetPos);
    expect(nodeAfter?.attrs.props).toEqual({ title: 'A-remote' });
    expect(isDirty(next, targetPos)).toBe(false);
  });

  test('sourceDirtyPluginKey is exported and locatable on the EditorState', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const located = sourceDirtyPluginKey.get(initial);
    expect(located).toBe(plugin);
  });

  test('insertion of a new local jsxComponent marks only the insertion dirty', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    const next = applyWithAppend(initial, (tr) => {
      const node = schema.node(
        'jsxComponent',
        {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: '',
          sourceDirty: false,
          props: { title: 'NEW' },
        },
        [schema.node('paragraph', null, [schema.text('new body')])],
      );
      return tr.insert(0, node);
    });

    expect(isDirty(next, 0)).toBe(true);
    const shifted = targetPos + (next.doc.firstChild?.nodeSize ?? 0);
    expect(isDirty(next, shifted)).toBe(false);
  });

  test('fresh-insert with authoritative sourceRaw stays pristine (I12 guard positive path)', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const insertPos = initial.doc.content.size;

    const next = applyWithAppend(initial, (tr) => {
      const node = schema.node(
        'jsxComponent',
        {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: '<Callout type="info">\ntext\n</Callout>',
          sourceDirty: false,
          props: { type: 'info' },
        },
        [schema.node('paragraph', null, [schema.text('text')])],
      );
      return tr.insert(insertPos, node);
    });

    expect(isDirty(next, insertPos)).toBe(false);
  });

  test('deny-list gates the interior-content route by origin, not by content', () => {
    const plugin = getSourceDirtyPlugin();

    {
      const initial = buildInitialState(plugin);
      const next = editInteriorText(initial, 'X');
      const [firstPos, secondPos] = componentPositions(next);
      expect(isDirty(next, firstPos)).toBe(true);
      expect(isDirty(next, secondPos)).toBe(false);
    }

    {
      const initial = buildInitialState(plugin);
      const next = editInteriorText(initial, 'X', true);
      const [firstPos] = componentPositions(next);
      expect(isDirty(next, firstPos)).toBe(false);
    }
  });

  test('freshly-inserted component stays pristine on insert, but its first interior edit flips', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const insertPos = initial.doc.content.size;

    const afterInsert = applyWithAppend(initial, (tr) => {
      const node = schema.node(
        'jsxComponent',
        {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: '<Callout type="info">\n\nfresh\n\n</Callout>',
          sourceDirty: false,
          props: { type: 'info' },
        },
        [schema.node('paragraph', null, [schema.text('fresh')])],
      );
      return tr.insert(insertPos, node);
    });
    expect(isDirty(afterInsert, insertPos)).toBe(false);

    const afterEdit = applyWithAppend(afterInsert, (tr) => tr.insertText('!', insertPos + 2));
    expect(isDirty(afterEdit, insertPos)).toBe(true);
  });
});
