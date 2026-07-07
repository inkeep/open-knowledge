/**
 * Source-dirty observer plugin.
 *
 * Watches PM transactions and marks jsxComponent nodes as sourceDirty:true
 * when their content or structured attrs change via user-intent transactions.
 *
 * Deny-listed origins (non-user-intent):
 * - y-prosemirror sync (ySyncPluginKey meta) — covers:
 *   - sync-from-text (Observer B)
 *   - sync-from-tree (Observer A)
 *   - agent-write (server agent-sessions)
 *   - rollback-apply (Timeline rollback)
 *   - remote WebSocket updates
 * - All of these arrive as PM transactions with ySyncPluginKey meta set
 *   to { isChangeOrigin: true } by y-prosemirror's sync plugin.
 *
 * Only user-intent transactions (keyboard, PropPanel, paste, drag-drop)
 * produce PM transactions without ySyncPluginKey meta — these mark dirty.
 *
 * jsxInline is excluded (no sourceDirty attr).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
// Sourced from @tiptap/y-tiptap (TipTap v3 official path), not y-prosemirror
// directly. This file's correctness depends on `tr.getMeta(ySyncPluginKey)`
// returning the meta value the y-prosemirror sync plugin sets when emitting
// CRDT-origin transactions — which only works if the PluginKey identity is
// the SAME constant the producer used. `@tiptap/y-tiptap` re-exports the
// y-prosemirror plugin keys from a single module-level instance; importing
// directly from `y-prosemirror` here would create a second PluginKey
// identity and silently make the origin-guard miss every CRDT-origin
// transaction (incorrectly marking them dirty). Aligns with bridge-id-plugin.ts
// + editor-cache.ts.
import { ySyncPluginKey } from '@tiptap/y-tiptap';

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
          // Skip if any transaction is from CRDT sync (not user-intent)
          const hasUserTransaction = transactions.some((tr) => {
            // y-prosemirror sets ySyncPluginKey meta on CRDT-origin transactions
            const syncMeta = tr.getMeta(ySyncPluginKey);
            return !syncMeta;
          });

          if (!hasUserTransaction) return null;

          // Only process transactions that actually changed the doc
          const docChanged = transactions.some((tr) => tr.docChanged);
          if (!docChanged) return null;

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
            // forces the auto-convert / serialize path to re-emit via the
            // to-markdown handler's canonical `<Open>\n\n<children>\n\n
            // <Close>` form, clobbering the user's exact input (e.g.,
            // `<Foo>\ntext\n</Foo>` serializes to `<Foo>\n\ntext\n\n
            // </Foo>`). Preserving sourceRaw here maintains the
            // "pristine → sourceRaw verbatim" invariant for newly-inserted
            // components.
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
