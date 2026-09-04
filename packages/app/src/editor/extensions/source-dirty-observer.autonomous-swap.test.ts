import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, type Plugin, TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
import { reconstructSource } from '../utils/reconstruct-source.ts';
import { markAutonomousFragmentEdit, markSwapIfByteNeutral } from './autonomous-fragment-edit.ts';
import { sharedExtensions } from './shared';
import {
  appendForBatch,
  applyWithAppend,
  getSourceDirtyPlugin,
} from './source-dirty-observer.test-helper';

const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: coreExtensions });

const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '</Steps>',
].join('\n');

function initialState(plugin: Plugin): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(STEPS));
  return EditorState.create({ schema, doc, plugins: [plugin] });
}

function firstStep(state: EditorState): { pos: number; node: PmNode } {
  let found: { pos: number; node: PmNode } | undefined;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'jsxComponent' && node.attrs.componentName === 'Step') {
      found = { pos, node };
      return false;
    }
    return true;
  });
  if (!found) throw new Error('fixture has no nested <Step> jsxComponent');
  return found;
}

function firstFallback(state: EditorState): { pos: number; node: PmNode } {
  let found: { pos: number; node: PmNode } | undefined;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'rawMdxFallback') {
      found = { pos, node };
      return false;
    }
    return true;
  });
  if (!found) throw new Error('no rawMdxFallback in the converted doc');
  return found;
}

function reparse(source: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(source)).child(0);
}

function convertFirstStepToFallback(state: EditorState): EditorState {
  const { pos, node } = firstStep(state);
  const fallback = schema.nodes.rawMdxFallback.create(
    { reason: `Unregistered component: ${node.attrs.componentName}` },
    schema.text(reconstructSource(node)),
  );
  return applyWithAppend(state, (tr) =>
    markAutonomousFragmentEdit(tr.replaceWith(pos, pos + node.nodeSize, fallback)),
  );
}

describe('SourceDirtyObserver — autonomous representation swaps', () => {
  test('the authored container bytes survive a nested wildcard auto-convert', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = initialState(plugin);
    expect(reconstructSource(initial.doc.child(0))).toBe(STEPS);

    const container = convertFirstStepToFallback(initial).doc.child(0);

    expect(reconstructSource(container)).toBe(STEPS);
    expect(container.attrs.sourceDirty).toBe(false);
  });

  test('the on-blur upgrade is stamped when its buffer matches the node it replaces', () => {
    const plugin = getSourceDirtyPlugin();
    const converted = convertFirstStepToFallback(initialState(plugin));
    const { pos, node } = firstFallback(converted);

    const next = applyWithAppend(converted, (tr) =>
      markSwapIfByteNeutral(
        tr.replaceWith(pos, pos + node.nodeSize, reparse(node.textContent)),
        node,
        node.textContent,
      ),
    );

    const container = next.doc.child(0);
    expect(reconstructSource(container)).toBe(STEPS);
    expect(container.attrs.sourceDirty).toBe(false);
  });

  test('the on-blur upgrade is NOT stamped when the buffer holds bytes PM never received', () => {
    const plugin = getSourceDirtyPlugin();
    const converted = convertFirstStepToFallback(initialState(plugin));
    const { pos, node } = firstFallback(converted);
    const edited = node.textContent.replace('Content one.', 'Content one EDITED.');
    expect(edited).not.toBe(node.textContent);

    const next = applyWithAppend(converted, (tr) =>
      markSwapIfByteNeutral(
        tr.replaceWith(pos, pos + node.nodeSize, reparse(edited)),
        node,
        edited,
      ),
    );

    const container = next.doc.child(0);
    expect(container.attrs.sourceDirty).toBe(true);
    expect(reconstructSource(container)).toContain('Content one EDITED.');
  });

  test('a batch whose doc-changing member is not the user does not mark dirty', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = initialState(plugin);
    const { pos } = firstStep(initial);

    const appended = appendForBatch(plugin, initial, [
      (state) =>
        state.tr.insertText('Z', pos + 2).setMeta(ySyncPluginKey, { isChangeOrigin: true }),
      (state) => state.tr.setSelection(TextSelection.create(state.doc, pos + 2)),
    ]);

    expect(appended ?? null).toBeNull();
  });

  test('a keystroke inside the container still marks it dirty, and re-derives it', () => {
    const plugin = getSourceDirtyPlugin();
    const initial = initialState(plugin);
    const { pos } = firstStep(initial);
    const next = applyWithAppend(initial, (tr) => tr.insertText('Z', pos + 2));

    const container = next.doc.child(0);
    expect(container.attrs.sourceDirty).toBe(true);
    expect(reconstructSource(container)).not.toBe(STEPS);
    expect(reconstructSource(container)).toContain('ZContent one.');
  });
});
