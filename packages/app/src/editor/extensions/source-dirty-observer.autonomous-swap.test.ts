/**
 * A NodeView's own representation swap must not dirty the container that
 * encloses it.
 *
 * An unregistered JSX container nests unregistered children (`<Steps>` around
 * `<Step>`), so every one of them renders through the wildcard descriptor and
 * auto-converts itself to a `rawMdxFallback`. Measured in a browser across
 * three runs, the nested child's swap dispatches before the container's; what
 * decides that order is not established here, only that it holds. The
 * container is therefore live when the child swaps, and that dispatch carries
 * no y-prosemirror sync meta, so without the stamp the dirty observer reads it
 * as a keystroke.
 *
 * See `markAutonomousFragmentEdit` for what a dirtied container costs.
 *
 * The assertions are on `reconstructSource` because that is what decides the
 * bytes a fallback carries when the container converts in its turn — the byte
 * boundary the whole chain hangs off.
 */

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

/** A nested unregistered JSX container, as a user authors it. */
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

/**
 * Locate the first nested `<Step>`. Walked rather than hardcoded: the fixture's
 * shape is `mdManager.parse`'s to change, and a stale offset would silently
 * build the swap out of the wrong node and keep the suite green.
 */
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

/** Locate the fallback a swap produced, by the same walk. */
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

/** What the on-blur handler replaces a fallback with: its buffer, re-parsed. */
function reparse(source: string): PmNode {
  return schema.nodeFromJSON(mdManager.parse(source)).child(0);
}

/** The transaction `JsxComponentView`'s wildcard auto-convert dispatches. */
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

    // Byte-for-byte, including the blank lines at the container boundary that
    // the re-derivation collapses to single newlines.
    expect(reconstructSource(container)).toBe(STEPS);
    expect(container.attrs.sourceDirty).toBe(false);
  });

  test('the on-blur upgrade is stamped when its buffer matches the node it replaces', () => {
    const plugin = getSourceDirtyPlugin();
    const converted = convertFirstStepToFallback(initialState(plugin));
    const { pos, node } = firstFallback(converted);

    // The production decision, not a re-implementation of it: the buffer the
    // user is looking at is byte-identical to what the node already holds.
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
    // The load-bearing arm. `forwardUpdate` can decline, so the nested buffer
    // may carry an edit the document has not seen; stamping it would suppress
    // dirty-marking for the user's own bytes and leave the container emitting
    // its stale `sourceRaw` over them.
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
    // The edit reaches the bytes rather than being overwritten by the
    // container's memory of what used to be there.
    expect(reconstructSource(container)).toContain('Content one EDITED.');
  });

  test('a batch whose doc-changing member is not the user does not mark dirty', () => {
    // What folding `docChanged` into the deny-list predicate buys. Scanned
    // separately, a batch pairing a CRDT-origin doc change with a user
    // selection-only transaction satisfies both halves and marks a container
    // dirty, which is a re-spell. ProseMirror really does produce mixed
    // batches: `prosemirror-tables`' `tableEditing` appends a selection-only
    // normalizing transaction.
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
    // +1 enters the <Step>, +1 enters its paragraph.
    const next = applyWithAppend(initial, (tr) => tr.insertText('Z', pos + 2));

    const container = next.doc.child(0);
    expect(container.attrs.sourceDirty).toBe(true);
    // The differential the byte assertion above rests on: a dirty container
    // really does emit something other than the authored bytes, re-derived
    // from the live tree rather than from the stale `sourceRaw`, so
    // `toBe(STEPS)` is a claim that can fail.
    expect(reconstructSource(container)).not.toBe(STEPS);
    expect(reconstructSource(container)).toContain('ZContent one.');
  });
});
