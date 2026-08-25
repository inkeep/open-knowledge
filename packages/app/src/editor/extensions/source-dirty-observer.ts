/**
 * Source-dirty observer plugin.
 *
 * Watches PM transactions and marks jsxComponent nodes as sourceDirty:true
 * when their content or structured attrs change via user-intent transactions.
 *
 * Two origins are deny-listed, and absence of `ySyncPluginKey` meta alone is
 * therefore NOT sufficient to call a transaction user-intent: CRDT sync, and a
 * NodeView's own representation swap. `isUserIntentOrigin` holds the canonical
 * enumeration of both; `markAutonomousFragmentEdit` holds the consequence of
 * getting the second one wrong, which lands hardest on this plugin. A
 * transaction carrying neither marker is the user's (keyboard, PropPanel,
 * paste, drag-drop) and marks dirty.
 *
 * jsxInline dirty-marking is owned by JsxInlineView's PropPanel commit
 * (position-targeted `setNodeMarkup` with `sourceDirty: true`), not this
 * observer — inline widgets are atomic, so typing never lands inside them.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { isUserIntentOrigin } from './autonomous-fragment-edit.ts';

/**
 * Stable PluginKey so consumers outside this file can locate the plugin
 * (`sourceDirtyPluginKey.get(state)`) without relying on the plugin's
 * array index. No PluginState is read through it today — the plugin's
 * effect is a side-effect (setting the `sourceDirty` attr), not a
 * readable state. The key is still exported so future consumers (e.g.,
 * a status indicator showing "N unsaved blocks") have a stable hook.
 */
export const sourceDirtyPluginKey = new PluginKey('sourceDirty');

export const SourceDirtyObserver = Extension.create({
  name: 'sourceDirtyObserver',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sourceDirtyPluginKey,
        appendTransaction(transactions, oldState, newState) {
          // One predicate over both conditions, so the transaction that admits
          // the batch has to be the one that changed the document. Tested
          // separately, a batch pairing a stamped swap with a user
          // selection-only transaction would satisfy both and mark dirty.
          if (!transactions.some((tr) => tr.docChanged && isUserIntentOrigin(tr))) return null;

          // Build a combined mapping from all transactions to map new-state
          // positions back to old-state positions. Without this, insertions or
          // deletions before a jsxComponent shift its position — using the same
          // numeric position in oldState would find the wrong node, causing
          // false-positive dirty marking that defeats the pristine γ path.
          const combinedMapping = new Mapping();
          for (const tr of transactions) {
            combinedMapping.appendMapping(tr.mapping);
          }
          // Invert once per observer firing. A fresh `invert()` allocates a
          // new Mapping of inverse steps; calling it inside the descendants
          // loop is O(nodes * steps) and shows up on docs with many
          // jsxComponents. The mapping is constant for the scope of this
          // appendTransaction call.
          const invertedMapping = combinedMapping.invert();

          const updates: Array<{ pos: number }> = [];

          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'jsxComponent') return;
            if (node.attrs.sourceDirty) return; // already dirty, skip

            // Map from newState position back to oldState position
            const oldPos = invertedMapping.map(pos);
            const oldNode = oldState.doc.nodeAt(oldPos);

            // Fresh-insert pristine-preservation guard: if this jsxComponent
            // is newly inserted at a position that did not formerly hold a
            // jsxComponent, AND it arrives with an authoritative `sourceRaw`
            // already populated (non-empty string), do NOT mark it dirty.
            //
            // Freshly-parsed jsxComponents from our mdast→PM handlers carry
            // a verbatim source string — the upgrade path (on-blur
            // rawMdxFallback → jsxComponent), MDX paste, and slash-menu
            // template inserts all produce this shape. Marking these dirty
            // routes them onto the reconstruct path, which re-spells the
            // container boundary rather than emitting what the user wrote;
            // the byte direction lives at `upstreamMdxJsxFlowHandler` in
            // `to-markdown-handlers.ts`, not restated here. Preserving
            // sourceRaw maintains the "pristine → sourceRaw verbatim"
            // invariant for newly-inserted components.
            //
            // This does NOT apply to user edits on existing jsxComponents:
            // a prop edit via `setNodeMarkup` spreads the old attrs
            // (preserving sourceRaw) but changes `props` — `oldNode` still
            // exists as a jsxComponent at the same position, and the
            // propsChanged/contentChanged comparison below correctly marks
            // dirty. The guard only applies when the position was empty
            // or held a different node type prior to this transaction.
            const isFreshInsert = !oldNode || oldNode.type.name !== 'jsxComponent';
            const hasAuthoritativeSource =
              typeof node.attrs.sourceRaw === 'string' && node.attrs.sourceRaw.length > 0;
            if (isFreshInsert && hasAuthoritativeSource) {
              return;
            }

            if (!oldNode) {
              // Node is new (inserted) — mark dirty if it has content
              if (node.content.size > 0 || Object.keys(node.attrs.props ?? {}).length > 0) {
                updates.push({ pos });
              }
              return;
            }

            if (oldNode.type.name !== 'jsxComponent') {
              // Position was a different node type before — new node here
              updates.push({ pos });
              return;
            }

            // Compare content and structured attrs (excluding sourceDirty itself)
            const propsChanged = !deepEqual(oldNode.attrs.props, node.attrs.props);
            const contentChanged = !oldNode.content.eq(node.content);

            if (propsChanged || contentChanged) {
              updates.push({ pos });
            }
          });

          if (updates.length === 0) return null;

          const tr = newState.tr;
          for (const { pos } of updates) {
            tr.setNodeAttribute(pos, 'sourceDirty', true);
          }
          return tr;
        },
      }),
    ];
  },
});

/**
 * Simple deep equality for attr comparison. Handles primitives,
 * arrays, and plain objects. Does NOT handle dates, maps, sets, etc.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  // Object.is handles NaN identity (a === b is false when both are NaN) so
  // numeric props with NaN values don't force γ reconstruction on every tx.
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
}
