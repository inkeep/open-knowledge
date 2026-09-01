/**
 * SourceDirtyObserver origin-guard regression test.
 *
 * Precedent #1 (typed transaction origins) exists because three shipped
 * three observer-bridge correctness bugs that all hinged on whether a CRDT
 * sync transaction was properly identified and skipped. This test drives
 * the source-dirty plugin at the PM-state level (the same surface the plugin
 * runs against in production inside a real EditorView + y-prosemirror). The
 * guard's truth table has three arms; this file owns the first two, and the
 * sibling suite `source-dirty-observer.autonomous-swap.test.ts` owns the third:
 *
 *   1. Transaction WITH `ySyncPluginKey` meta set → appendTransaction must
 *      return null. This covers every CRDT-origin path: Observer A/B,
 *      agent-write, rollback-apply, file-watcher, remote WebSocket. None
 *      of these should flip `sourceDirty` on the local view.
 *   2. Transaction with NEITHER `ySyncPluginKey` meta nor the autonomous
 *      stamp → appendTransaction must return a new tr that sets
 *      `sourceDirty: true` on mutated jsxComponent nodes ONLY. Siblings with
 *      no prop or content change must stay pristine (the reconstruction path
 *      applies per-node, so any false-positive dirty on a sibling silently
 *      corrupts unrelated content on save).
 *   3. Transaction carrying the autonomous stamp but no sync meta → must NOT
 *      mark dirty; absence of sync meta alone is not user intent. Covered by
 *      the sibling suite, not here.
 *
 * A future refactor that renames `ySyncPluginKey`, strips meta via an
 * intermediate plugin, or replaces the meta check with something else fails
 * this test before it can ship. Runs at the PM-state level rather than
 * through Hocuspocus because the guard's correctness is a per-transaction
 * property of the plugin itself — the multi-client integration harness
 * would add orders of magnitude of wall time without adding signal.
 */

import { getSchema } from '@tiptap/core';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
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

function editInteriorText(state: EditorState, text: string, syncMeta?: unknown): EditorState {
  const innerTextPos = firstComponentPos(state) + 2;
  return applyWithAppend(state, (tr) => {
    if (syncMeta !== undefined) tr.setMeta(ySyncPluginKey, syncMeta);
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

  test('CRDT-origin transaction with ySyncPluginKey meta does NOT mark dirty', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    const next = applyWithAppend(initial, (tr) => {
      const node = initial.doc.nodeAt(targetPos);
      if (!node) throw new Error('Target vanished');
      tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
      return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'A-crdt' } });
    });

    const nodeAfter = next.doc.nodeAt(targetPos);
    expect(nodeAfter?.attrs.props).toEqual({ title: 'A-crdt' });
    expect(isDirty(next, targetPos)).toBe(false);
  });

  test('meta truthiness — any non-nullish ySyncPluginKey meta short-circuits', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    for (const stamp of [
      { isChangeOrigin: true },
      { isUndoRedoOperation: true },
      { other: 'payload' },
      true,
      1,
    ]) {
      const next = applyWithAppend(initial, (tr) => {
        const node = initial.doc.nodeAt(targetPos);
        if (!node) throw new Error('Target vanished');
        tr.setMeta(ySyncPluginKey, stamp);
        return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'x' } });
      });
      expect(isDirty(next, targetPos)).toBe(false);
    }
  });

  test('sourceDirtyPluginKey is exported and locatable on the EditorState', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = buildInitialState(plugin);
    const located = sourceDirtyPluginKey.get(initial);
    expect(located).toBe(plugin);
  });

  test('insertion of a new non-CRDT jsxComponent marks only the insertion dirty', () => {
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
      const next = editInteriorText(initial, 'X', { isChangeOrigin: true });
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
