/**
 * `getPmStats(editor)` — single canonical query of a TipTap/PM editor's
 * structural counts. Walks `editor.state.doc.descendants()` once for
 * node + mark counts, reads `editor.view.nodeViews` for the registered
 * NodeView constructor count, and walks `editor.state.plugins` calling
 * each `props.decorations(state)` for the decoration count.
 *
 * Replaces ad-hoc `grep`-based markdown counting and DOM-selector counts
 * (`document.querySelectorAll('[data-mark-id]')` misses CV:auto-skipped
 * chunks; this walks PM state instead of the DOM).
 *
 * Dev-mode-only — the pure walks are cheap (<50ms on a ~39K-node doc)
 * but `props.decorations` may execute non-trivial plugin logic. Don't
 * put this on a hot path; call it from probes and one-shot regression
 * measurements.
 */

import type { Editor } from '@tiptap/core';
import type { EditorState, Plugin } from '@tiptap/pm/state';
import type { DecorationSet, DecorationSource, EditorView } from '@tiptap/pm/view';

export interface PmStats {
  /** Total descendant node count (excludes the root `doc` node — same shape as `Node.descendants()` traversal). */
  nodeCount: number;
  /** Per-type node counts keyed by `node.type.name`. */
  nodeCountByType: Record<string, number>;
  /** Total mark count summed across all descendant nodes. A single mark sliced across N text nodes contributes N. */
  markCount: number;
  /** Per-type mark counts keyed by `mark.type.name`. */
  markCountByType: Record<string, number>;
  /** Number of registered NodeView constructors (`Object.keys(view.nodeViews).length`). */
  nodeViewCount: number;
  /** Total decoration count across all plugins that define `props.decorations`. */
  decorationCount: number;
  /** Per-plugin decoration counts. Keys are the plugin's `spec.key.key` (when a `PluginKey` was supplied) or `unkeyed-${index}` otherwise. */
  decorationCountByPlugin: Record<string, number>;
}

interface EditorLike {
  state: EditorState;
  view?: EditorView | null;
}

/**
 * Compute structural counts. Accepts a TipTap `Editor` or any
 * structurally-compatible shape (`{state, view}`) — letting tests
 * pass a partial stub without spinning up a live editor.
 */
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
    // `nodeViews` is a runtime field on `EditorView` (assigned via
    // `buildNodeViews(this)` in `prosemirror-view`); it isn't in the
    // public type surface, hence the cast.
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
      // PM binds `this` to the plugin when calling `props.*`. Preserve that.
      source = decorationsFn.call(plugin, state);
    } catch {
      // A plugin's decorations callback should never throw, but if it does
      // we don't want one buggy plugin to take the whole probe down.
      continue;
    }
    if (!source) continue;

    let count = 0;
    try {
      // `forEachSet` is the universal DecorationSource accessor — defined
      // on both `DecorationSet` (calls `f(this)`) and `DecorationGroup`
      // (recurses into members).
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

/**
 * Stable string identifier for a plugin. Prefer `spec.key.key` (the
 * `PluginKey`'s internal name set at construction); fall back to
 * `plugin.key` (auto-generated `plugin$N` for keyless plugins) and
 * finally to a positional `unkeyed-${index}`.
 */
function pluginKeyOf(plugin: Plugin, index: number): string {
  const specKey = (plugin.spec as unknown as { key?: { key?: string } }).key;
  if (specKey && typeof specKey.key === 'string' && specKey.key.length > 0) {
    return specKey.key;
  }
  const pluginKey = (plugin as unknown as { key?: string }).key;
  if (typeof pluginKey === 'string' && pluginKey.length > 0) return pluginKey;
  return `unkeyed-${index}`;
}
