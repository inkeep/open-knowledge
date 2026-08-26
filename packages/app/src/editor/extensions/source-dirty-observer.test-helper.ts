/**
 * Shared rig for the `SourceDirtyObserver` suites.
 *
 * Both suites drive the plugin at the PM-state level, which is the surface it
 * runs against inside a real EditorView, and both need the same two pieces:
 * the plugin instance out of the TipTap extension, and a transaction applied
 * through a state that has the plugin registered.
 */
import type { EditorState, Plugin, Transaction } from '@tiptap/pm/state';
import { SourceDirtyObserver } from './source-dirty-observer';

/**
 * Invoke `appendTransaction` with a MULTI-transaction batch and return what it
 * produced (`null`/`undefined` for "nothing to mark").
 *
 * `state.apply` drives the hook with a one-element array, so a predicate that
 * scans across a batch cannot be exercised through it at all. ProseMirror hands
 * the hook every transaction from one dispatch round, which is the shape this
 * reproduces. Each transaction is applied in turn only to build the end state
 * the hook is given; those per-transaction hook runs are not the subject.
 *
 * CONSTRAINT: those intermediate applies re-enter the plugin. A batch whose
 * doc-changing member is itself user-intent therefore marks the node before the
 * explicit call runs, and the call then returns `null` off `already dirty,
 * skip` — a pass that never consulted the batch predicate. Build batches whose
 * members cannot mark on their own, or the test proves nothing.
 */
export function appendForBatch(
  plugin: Plugin,
  state: EditorState,
  builders: Array<(state: EditorState) => Transaction>,
): Transaction | null | undefined {
  const transactions: Transaction[] = [];
  let newState = state;
  // Each builder gets the state its transaction will apply to; building both
  // from the original state produces a mismatched transaction, which is not a
  // shape ProseMirror can hand the hook.
  for (const build of builders) {
    const tr = build(newState);
    transactions.push(tr);
    newState = newState.apply(tr);
  }
  const spec = plugin.spec as { appendTransaction?: typeof plugin.spec.appendTransaction };
  return spec.appendTransaction?.(transactions, state, newState);
}

/**
 * Resolve the PM plugin instance from the extension's `addProseMirrorPlugins`.
 * Tiptap wraps `addProseMirrorPlugins` on the extension definition; invoking
 * it with the extension's `this` bound to a minimal stub is enough — the
 * implementation only uses `Plugin` + `PluginKey`, no editor state.
 */
export function getSourceDirtyPlugin(): Plugin {
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
 * Apply a transaction to a state that has the plugin registered, so
 * `appendTransaction` runs exactly as ProseMirror runs it: `state.apply`
 * drives the whole hook loop, and the returned state already carries whatever
 * the observer appended.
 */
export function applyWithAppend(
  state: EditorState,
  mutate: (tr: Transaction) => Transaction,
): EditorState {
  return state.apply(mutate(state.tr));
}
