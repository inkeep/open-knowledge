import type { EditorState, Plugin, Transaction } from '@tiptap/pm/state';
import { SourceDirtyObserver } from './source-dirty-observer';

export function appendForBatch(
  plugin: Plugin,
  state: EditorState,
  builders: Array<(state: EditorState) => Transaction>,
): Transaction | null | undefined {
  const transactions: Transaction[] = [];
  let newState = state;
  for (const build of builders) {
    const tr = build(newState);
    transactions.push(tr);
    newState = newState.apply(tr);
  }
  const spec = plugin.spec as { appendTransaction?: typeof plugin.spec.appendTransaction };
  return spec.appendTransaction?.(transactions, state, newState);
}

export function getSourceDirtyPlugin(): Plugin {
  const ext = SourceDirtyObserver.configure({});
  const pluginsFn = (ext.config as { addProseMirrorPlugins?: () => Plugin[] })
    .addProseMirrorPlugins;
  if (!pluginsFn) throw new Error('SourceDirtyObserver missing addProseMirrorPlugins');
  const plugins = pluginsFn.call({} as never);
  if (plugins.length === 0) throw new Error('SourceDirtyObserver returned no plugins');
  return plugins[0];
}

export function applyWithAppend(
  state: EditorState,
  mutate: (tr: Transaction) => Transaction,
): EditorState {
  return state.apply(mutate(state.tr));
}
