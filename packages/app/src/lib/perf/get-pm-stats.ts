import type { Editor } from '@tiptap/core';
import type { EditorState, Plugin } from '@tiptap/pm/state';
import type { DecorationSet, DecorationSource, EditorView } from '@tiptap/pm/view';

export interface PmStats {
  nodeCount: number;
  nodeCountByType: Record<string, number>;
  markCount: number;
  markCountByType: Record<string, number>;
  nodeViewCount: number;
  decorationCount: number;
  decorationCountByPlugin: Record<string, number>;
}

interface EditorLike {
  state: EditorState;
  view?: EditorView | null;
}

export function getPmStats(editor: Editor | EditorLike): PmStats {
  const stats: PmStats = {
    nodeCount: 0,
    nodeCountByType: {},
    markCount: 0,
    markCountByType: {},
    nodeViewCount: 0,
    decorationCount: 0,
    decorationCountByPlugin: {},
  };

  const state = editor.state;
  const view = (editor as EditorLike).view ?? null;

  state.doc.descendants((node) => {
    stats.nodeCount += 1;
    const typeName = node.type.name;
    stats.nodeCountByType[typeName] = (stats.nodeCountByType[typeName] ?? 0) + 1;
    for (const mark of node.marks) {
      stats.markCount += 1;
      const markName = mark.type.name;
      stats.markCountByType[markName] = (stats.markCountByType[markName] ?? 0) + 1;
    }
    return true;
  });

  if (view) {
    const nodeViewMap = (view as unknown as { nodeViews?: Record<string, unknown> }).nodeViews;
    if (nodeViewMap) {
      stats.nodeViewCount = Object.keys(nodeViewMap).length;
    }
  }

  const plugins = state.plugins;
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i] as Plugin;
    const decorationsFn = plugin.props?.decorations;
    if (typeof decorationsFn !== 'function') continue;

    let source: DecorationSource | null | undefined;
    try {
      source = decorationsFn.call(plugin, state);
    } catch {
      continue;
    }
    if (!source) continue;

    let count = 0;
    try {
      source.forEachSet((set: DecorationSet) => {
        const found = set.find();
        if (Array.isArray(found)) count += found.length;
      });
    } catch {
      continue;
    }
    if (count === 0) continue;

    const pluginKeyName = pluginKeyOf(plugin, i);
    stats.decorationCount += count;
    stats.decorationCountByPlugin[pluginKeyName] =
      (stats.decorationCountByPlugin[pluginKeyName] ?? 0) + count;
  }

  return stats;
}

function pluginKeyOf(plugin: Plugin, index: number): string {
  const specKey = (plugin.spec as unknown as { key?: { key?: string } }).key;
  if (specKey && typeof specKey.key === 'string' && specKey.key.length > 0) {
    return specKey.key;
  }
  const pluginKey = (plugin as unknown as { key?: string }).key;
  if (typeof pluginKey === 'string' && pluginKey.length > 0) return pluginKey;
  return `unkeyed-${index}`;
}
