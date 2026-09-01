import type { Editor } from '@tiptap/core';

export interface SuggestionPluginState {
  active: boolean;
}

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
