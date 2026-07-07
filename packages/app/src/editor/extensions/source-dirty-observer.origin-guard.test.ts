/**
 * SourceDirtyObserver origin-guard regression test.
 *
 * Precedent #1 (typed transaction origins) exists because three shipped
 * three observer-bridge correctness bugs that all hinged on whether a CRDT
 * sync transaction was properly identified and skipped. This test drives
 * the source-dirty plugin at the PM-state level (the same surface the plugin
 * runs against in production inside a real EditorView + y-prosemirror) with
 * both branches of the guard's truth table:
 *
 *   1. Transaction WITH `ySyncPluginKey` meta set → appendTransaction must
 *      return null. This covers every CRDT-origin path: Observer A/B,
 *      agent-write, rollback-apply, file-watcher, remote WebSocket. None
 *      of these should flip `sourceDirty` on the local view.
 *   2. Transaction WITHOUT `ySyncPluginKey` meta → appendTransaction must
 *      return a new tr that sets `sourceDirty: true` on mutated jsxComponent
 *      nodes ONLY. Siblings with no prop or content change must stay
 *      pristine (the reconstruction path applies per-node, so any
 *      false-positive dirty on a sibling silently corrupts unrelated
 *      content on save).
 *
 * A future refactor that renames `ySyncPluginKey`, strips meta via an
 * intermediate plugin, or replaces the meta check with something else fails
 * this test before it can ship. Runs at the PM-state level rather than
 * through Hocuspocus because the guard's correctness is a per-transaction
 * property of the plugin itself — the multi-client integration harness
 * would add orders of magnitude of wall time without adding signal.
 */
import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { EditorState, type Plugin, type Transaction } from '@tiptap/pm/state';
// Same source as source-dirty-observer.ts (and bridge-id-plugin.ts +
// editor-cache.ts). Test correctness depends on the SAME PluginKey
// identity the production module imports; using y-prosemirror here would
// produce a stale meta-key that the production module's sync plugin would
// never tag, causing the origin-guard test to assert the wrong behavior.
// Pinned by y-prosemirror-import-coverage.test.ts.
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { sharedExtensions } from './shared';
import { SourceDirtyObserver, sourceDirtyPluginKey } from './source-dirty-observer';

const schema = getSchema(sharedExtensions);

// Resolve the PM plugin instance from the extension's `addProseMirrorPlugins`.
// Tiptap wraps `addProseMirrorPlugins` on the extension definition; invoking
// it with the extension's `this` bound to a minimal stub is enough — the
// implementation only uses `Plugin` + `PluginKey`, no editor state.
function getPlugin(): Plugin {
  const ext = SourceDirtyObserver.configure({});
  // TipTap's Extension.configure returns a factory; `config.addProseMirrorPlugins`
  // is on the base config object but not exposed in the public types.
  const pluginsFn = (ext.config as { addProseMirrorPlugins?: () => Plugin[] })
    .addProseMirrorPlugins;
  if (!pluginsFn) throw new Error('SourceDirtyObserver missing addProseMirrorPlugins');
  const plugins = pluginsFn.call({} as never);
  if (plugins.length === 0) throw new Error('SourceDirtyObserver returned no plugins');
  return plugins[0];
}

/**
 * Build a doc with one `jsxComponent` block containing a paragraph child.
 * The block starts `sourceDirty: false` and carries `props: { title: 'A' }`
 * so we can observe props-change-driven dirty marking.
 */
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

/** Find the first jsxComponent in the doc and return its position. */
function firstComponentPos(state: EditorState): number {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos !== -1) return false;
    if (node.type.name === 'jsxComponent') pos = p;
  });
  if (pos === -1) throw new Error('No jsxComponent in doc');
  return pos;
}

/** Read sourceDirty attr at a specific position. */
function isDirty(state: EditorState, pos: number): boolean {
  const node = state.doc.nodeAt(pos);
  if (!node) throw new Error(`No node at pos ${pos}`);
  return Boolean(node.attrs.sourceDirty);
}

/**
 * Apply a transaction and run `appendTransaction` + apply its result, so the
 * resulting state matches what a real PM editor would see after the plugin
 * appends its dirty-marking transaction. Returns the post-append state.
 */
function applyWithAppend(
  plugin: Plugin,
  state: EditorState,
  mutate: (tr: Transaction) => Transaction,
): EditorState {
  const userTr = mutate(state.tr);
  const intermediate = state.apply(userTr);
  const spec = plugin.spec as { appendTransaction?: typeof plugin.spec.appendTransaction };
  const appended = spec.appendTransaction?.([userTr], state, intermediate);
  if (!appended) return intermediate;
  return intermediate.apply(appended);
}

describe('SourceDirtyObserver origin guard', () => {
  test('user-intent prop edit marks only the mutated jsxComponent dirty', () => {
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);
    const secondPos = targetPos + (initial.doc.nodeAt(targetPos)?.nodeSize ?? 0);

    expect(isDirty(initial, targetPos)).toBe(false);
    expect(isDirty(initial, secondPos)).toBe(false);

    const next = applyWithAppend(plugin, initial, (tr) => {
      const node = initial.doc.nodeAt(targetPos);
      if (!node) throw new Error('Target vanished');
      return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'A-new' } });
    });

    expect(isDirty(next, targetPos)).toBe(true); // mutated → dirty
    // Sibling position shifts by 0 for setNodeMarkup (no size change), so the
    // second block still sits at the same position and must stay pristine.
    expect(isDirty(next, secondPos)).toBe(false);
  });

  test('CRDT-origin transaction with ySyncPluginKey meta does NOT mark dirty', () => {
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    const next = applyWithAppend(plugin, initial, (tr) => {
      const node = initial.doc.nodeAt(targetPos);
      if (!node) throw new Error('Target vanished');
      // Simulate what y-prosemirror's sync-plugin does: stamp the meta on
      // the transaction so downstream plugins can identify the origin.
      tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
      return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'A-crdt' } });
    });

    // The prop change landed (CRDT-origin transactions still apply), but
    // the plugin must NOT mark sourceDirty — that flip would force
    // reconstruction on save for content the local user never
    // edited, silently corrupting un-touched siblings on the next write.
    const nodeAfter = next.doc.nodeAt(targetPos);
    expect(nodeAfter?.attrs.props).toEqual({ title: 'A-crdt' });
    expect(isDirty(next, targetPos)).toBe(false);
  });

  test('meta truthiness — any non-nullish ySyncPluginKey meta short-circuits', () => {
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    // y-prosemirror actually stamps a full sync-state object; our guard
    // keys only on truthiness per `tr.getMeta(ySyncPluginKey)` return.
    for (const stamp of [
      { isChangeOrigin: true },
      { isUndoRedoOperation: true },
      { other: 'payload' },
      true,
      1,
    ]) {
      const next = applyWithAppend(plugin, initial, (tr) => {
        const node = initial.doc.nodeAt(targetPos);
        if (!node) throw new Error('Target vanished');
        tr.setMeta(ySyncPluginKey, stamp);
        return tr.setNodeMarkup(targetPos, null, { ...node.attrs, props: { title: 'x' } });
      });
      expect(isDirty(next, targetPos)).toBe(false);
    }
  });

  test('sourceDirtyPluginKey is exported and locatable on the EditorState', () => {
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    // The plugin must register under the exported key so future consumers
    // (status indicators, telemetry) can locate it without relying on
    // plugin-array index.
    const located = sourceDirtyPluginKey.get(initial);
    expect(located).toBe(plugin);
  });

  test('insertion of a new non-CRDT jsxComponent marks only the insertion dirty', () => {
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    const targetPos = firstComponentPos(initial);

    const next = applyWithAppend(plugin, initial, (tr) => {
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

    // Inserted block is dirty (has content + non-empty props).
    expect(isDirty(next, 0)).toBe(true);
    // Original targetPos shifted by the inserted node's size — pristine node
    // preserved through the mapping (the whole point of
    // `combinedMapping.invert()` in the plugin; a regression that dropped
    // the inversion would false-positive-mark this sibling).
    const shifted = targetPos + (next.doc.firstChild?.nodeSize ?? 0);
    expect(isDirty(next, shifted)).toBe(false);
  });

  test('fresh-insert with authoritative sourceRaw stays pristine (I12 guard positive path)', () => {
    // Positive-path coverage for the fresh-insert pristine-preservation
    // guard in source-dirty-observer: a jsxComponent arriving at a
    // previously-empty position with a non-empty `sourceRaw` (the shape
    // produced by mdast→PM parse handlers, on-blur rawMdxFallback upgrade,
    // MDX paste, and slash-menu template inserts) must NOT be marked
    // dirty. Marking dirty would force the serialize path to re-emit the
    // component through the to-markdown handler's canonical form,
    // clobbering the user's authored bytes (e.g., `<Foo>\ntext\n</Foo>`
    // → `<Foo>\n\ntext\n\n</Foo>`).
    //
    // Append-at-end is the clean positive-path setup: the old-state
    // position past content.size doesn't resolve to any existing
    // jsxComponent, so `isFreshInsert` is true. Inserting at pos 0 would
    // map back to the first existing jsxComponent and defeat the guard's
    // `oldNode.type.name !== 'jsxComponent'` branch.
    const plugin = getPlugin();
    const initial = buildInitialState(plugin);
    const insertPos = initial.doc.content.size;

    const next = applyWithAppend(plugin, initial, (tr) => {
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

    // The freshly-inserted jsxComponent arrived with an authoritative
    // sourceRaw → guard fires → NOT dirty, even though the node has
    // content AND non-empty props.
    expect(isDirty(next, insertPos)).toBe(false);
  });
});
