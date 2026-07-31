/**
 * Shared plugin-key discovery for the `@tiptap/suggestion` gating suites.
 *
 * The three pickers build their keys with `new PluginKey('<name>')`, which
 * synthesizes a unique suffix (`<name>$` or `<name>$<n>`), and none of the
 * three exports its key — so a test matches on the prefix rather than widening
 * the production surface. That discovery mechanism is the part worth sharing:
 * if the suffix format ever changes, one file has to learn about it, not each
 * suite independently.
 */

import type { Editor } from '@tiptap/core';

/** The subset of `@tiptap/suggestion`'s reducer state the gating suites read. */
export interface SuggestionPluginState {
  active: boolean;
}

/** The suggestion plugin whose key starts with `keyPrefix`, or null. */
export function getSuggestionState(
  editor: Editor,
  keyPrefix: string,
): SuggestionPluginState | null {
  const plugin = editor.state.plugins.find((p) => {
    const keyName = (p as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    return typeof keyName === 'string' && keyName.startsWith(keyPrefix);
  });
  if (!plugin) return null;
  return (plugin.getState(editor.state) as SuggestionPluginState | undefined) ?? null;
}

/**
 * Every mounted plugin carrying the `@tiptap/suggestion` reducer state shape,
 * by key name. Read off the live editor rather than off source text, so a
 * picker registered through any code path is seen.
 */
export function suggestionPluginKeys(editor: Editor): string[] {
  const keys: string[] = [];
  for (const plugin of editor.state.plugins) {
    const state = plugin.getState(editor.state) as Record<string, unknown> | undefined;
    if (!state || typeof state !== 'object') continue;
    if (!('active' in state && 'range' in state && 'query' in state)) continue;
    const keyName = (plugin as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    if (typeof keyName === 'string') keys.push(keyName);
  }
  return keys.sort();
}
