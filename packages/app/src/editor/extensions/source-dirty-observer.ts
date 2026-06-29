import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

export const sourceDirtyPluginKey = new PluginKey('sourceDirty');

export const SourceDirtyObserver = Extension.create({
  name: 'sourceDirtyObserver',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sourceDirtyPluginKey,
        appendTransaction(transactions, oldState, newState) {
          const hasUserTransaction = transactions.some((tr) => {
            const syncMeta = tr.getMeta(ySyncPluginKey);
            return !syncMeta;
          });

          if (!hasUserTransaction) return null;

          const docChanged = transactions.some((tr) => tr.docChanged);
          if (!docChanged) return null;

          const combinedMapping = new Mapping();
          for (const tr of transactions) {
            combinedMapping.appendMapping(tr.mapping);
          }
          const invertedMapping = combinedMapping.invert();

          const updates: Array<{ pos: number }> = [];

          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'jsxComponent') return;
            if (node.attrs.sourceDirty) return; // already dirty, skip

            const oldPos = invertedMapping.map(pos);
            const oldNode = oldState.doc.nodeAt(oldPos);

            const isFreshInsert = !oldNode || oldNode.type.name !== 'jsxComponent';
            const hasAuthoritativeSource =
              typeof node.attrs.sourceRaw === 'string' && node.attrs.sourceRaw.length > 0;
            if (isFreshInsert && hasAuthoritativeSource) {
              return;
            }

            if (!oldNode) {
              if (node.content.size > 0 || Object.keys(node.attrs.props ?? {}).length > 0) {
                updates.push({ pos });
              }
              return;
            }

            if (oldNode.type.name !== 'jsxComponent') {
              updates.push({ pos });
              return;
            }

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

function deepEqual(a: unknown, b: unknown): boolean {
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
