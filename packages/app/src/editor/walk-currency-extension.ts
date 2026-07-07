import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '../lib/perf/mark';

/**
 * Walk-currency enforcement for the Pattern D pre-warm path.
 *
 * `buildPatternDConstructorOptions` derives `content` + `ySyncOptions.mapping`
 * from one `initProseMirrorDoc` walk of the Y.XmlFragment, and supplying a
 * mapping makes the vendored ySyncPlugin skip its on-mount `_forceRerender()`
 * (y-tiptap.cjs:263-268). The binding's own Y observer registers only at view
 * init (`binding.initView`, y-tiptap.cjs:751-756), so the pair carries a
 * client-owed precondition: the fragment must not have changed between the
 * walk and view-bind. A remote update landing in the construct→mount gap (the
 * post-construct `scheduler.yield()` window in mount-promise.ts, where
 * provider WebSocket messages process) is otherwise never reconciled into
 * ProseMirror — and the first post-mount transaction without y-sync meta
 * republishes the stale PM replica wholesale, erasing the remote edit from
 * the CRDT for every peer and disk.
 *
 * Enforcement is detect-and-restore at the consumption boundary:
 *  - `onBeforeCreate` fires synchronously inside `new Editor(...)` — the same
 *    synchronous task as the walk, so registering the `observeDeep` dirty
 *    flag here is currency-equivalent to walk time.
 *  - The plugin's `view()` init runs strictly after the binding's `initView`
 *    (Collaboration's `priority: 1e3` sorts its plugins ahead of this
 *    extension's default 100; ProseMirror creates plugin views in
 *    plugins-array order). The only other `priority: 1000` extension,
 *    `BridgeIdPlugin`, carries no plugin `view()`, so no priority-1000 view
 *    interleaves between `initView` and this check; a future view-bearing
 *    `priority: 1000` extension sorted ahead of this one would need this
 *    ordering re-verified. It unhooks the flag and, only when a fragment
 *    change landed in the gap, calls `binding._forceRerender()` — the
 *    vendored plugin's own invalidation primitive, the exact call it skips
 *    when a mapping is supplied. A stale pre-warm pair thereby degrades to
 *    the legacy no-mapping mount, which derives PM from the CURRENT fragment.
 *  - Non-stale mounts (the overwhelming majority) pay one observer
 *    register/unregister and a boolean check — the pre-warm fast path is
 *    fully preserved.
 *
 * Vendored-source line citations refer to `@tiptap/y-tiptap` 3.0.3 —
 * re-verify them when bumping that dependency.
 */

export interface WalkCurrencyExtensionOptions {
  /** The fragment the pre-warm walk derived `content`/`mapping` from — the
   *  same fragment Collaboration binds (`provider.document`, field 'default'). */
  fragment: Y.XmlFragment;
  docName: string;
}

/**
 * Returns an Extension rather than a raw ProseMirror Plugin (the sibling
 * `bindingStalenessGuardPlugin`'s shape) because the construct-time observer
 * needs the `onBeforeCreate` + `onDestroy` editor lifecycle hooks — emitted
 * synchronously inside `new Editor(...)` and on `destroy()` of never-mounted
 * editors — which raw plugins (whose view lifecycle only starts at mount)
 * never receive.
 */
export function walkCurrencyExtension(options: WalkCurrencyExtensionOptions): Extension {
  const { fragment, docName } = options;

  let stale = false;
  let observing = false;
  // One enforcement per editor instance, even across view() re-init
  // (StrictMode double-mount and park/revive re-run plugin views on the SAME
  // plugin instance, hence the same closure). An unmount→remount of the same
  // editor re-enters the staleness class at a different seam (the binding
  // unobserves while unmounted and the non-null mapping again skips
  // `_forceRerender`); that window is intentionally not covered — Pattern D
  // has no production unmount→remount path (park/revive reparents view.dom
  // without recreating the EditorView).
  let enforced = false;

  const markStale = (): void => {
    stale = true;
  };

  // Both disarm branches emit the same consequence + vendored-citation tail;
  // only the lead clause (which names the broken seam and places `docName`
  // differently) varies. `lead` carries that reason-specific prefix so the
  // shared tail lives in one place and cannot drift between branches.
  const disarmWarn = (lead: string): void => {
    console.warn(
      `[walk-currency] ${lead} at view init — stale pre-warm cannot be invalidated: a remote edit that landed in the construct→mount gap will not render, and the first local transaction may silently erase it from the CRDT for every peer and disk (vendored y-tiptap contract change? re-verify y-tiptap.cjs:263-268)`,
    );
  };

  const unobserve = (): void => {
    if (!observing) return;
    observing = false;
    fragment.unobserveDeep(markStale);
  };

  const enforce = (view: EditorView): void => {
    const syncState = ySyncPluginKey.getState(view.state) as
      | { binding?: { _forceRerender?: () => void } | null }
      | null
      | undefined;
    const binding = syncState?.binding;
    // This extension only rides along when a pre-warm mapping was handed to
    // ySyncPlugin, so a missing binding (or seam) at view init means the
    // vendored y-tiptap contract changed under us. Fail open (the editor
    // keeps working, at worst with the unenforced pre-warm behavior) but
    // loudly: the stale pre-warm stays unreconciled.
    if (!binding) {
      mark.count('ok/editor/walk-currency-disarmed', { docName, reason: 'no-binding' });
      disarmWarn(`no ySync binding on "${docName}"`);
      return;
    }
    if (typeof binding._forceRerender !== 'function') {
      mark.count('ok/editor/walk-currency-disarmed', { docName, reason: 'no-force-rerender' });
      disarmWarn(`ySync binding on "${docName}" exposes no _forceRerender`);
      return;
    }
    mark.count('ok/editor/pattern-d-stale-prewarm', { docName });
    // Dispatching from a plugin-view init while view.updateState is still
    // creating plugin views is the legacy no-mapping path's own proven
    // behavior — ySyncPlugin calls `_forceRerender()` from its view init when
    // mapping == null. The rerender dispatch runs inside `binding.mux`, so
    // ySyncPlugin's view-update write-back is mutex-skipped and nothing
    // republishes to Y.
    //
    // Intentionally unprotected — do NOT wrap in try/catch. A throw here
    // propagates through plugin-view init → `editor.mount()` → mount-promise's
    // mount-failed catch, which tears down the partial editor and rejects to
    // DocumentErrorBoundary. A local catch would instead let the editor mount
    // with the stale pre-warm un-invalidated — the silent data loss this
    // extension exists to prevent.
    binding._forceRerender();
  };

  return Extension.create({
    name: 'walkCurrency',

    onBeforeCreate() {
      fragment.observeDeep(markStale);
      observing = true;
    },

    onDestroy() {
      // `Editor.destroy()` emits `destroy` even for never-mounted editors,
      // so this covers every mount-promise abort/invalidate route (which
      // destroys the pre-mount editor without the plugin view ever
      // initializing). `unobserveDeep` is a filter removal — idempotent
      // after the view-init unhook.
      unobserve();
    },

    addProseMirrorPlugins() {
      return [
        new Plugin({
          view: (view) => {
            if (!enforced) {
              enforced = true;
              unobserve();
              if (stale) enforce(view);
            }
            return {};
          },
        }),
      ];
    },
  });
}
