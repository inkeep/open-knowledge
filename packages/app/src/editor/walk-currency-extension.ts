import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '../lib/perf/mark';


export interface WalkCurrencyExtensionOptions {
  /** The fragment the pre-warm walk derived `content`/`mapping` from — the
   *  same fragment Collaboration binds (`provider.document`, field 'default'). */
  fragment: Y.XmlFragment;
  docName: string;
}

export function walkCurrencyExtension(options: WalkCurrencyExtensionOptions): Extension {
  const { fragment, docName } = options;

  let stale = false;
  let observing = false;
  let enforced = false;

  const markStale = (): void => {
    stale = true;
  };

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
    binding._forceRerender();
  };

  return Extension.create({
    name: 'walkCurrency',

    onBeforeCreate() {
      fragment.observeDeep(markStale);
      observing = true;
    },

    onDestroy() {
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
