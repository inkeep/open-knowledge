/**
 * linkResolutionDecorationPlugin — decorates tracked link marks with caller-computed
 * attributes (typically `data-resolution-state`), refreshed whenever the module-level
 * page-list cache changes.
 *
 * Why this plugin exists
 * ----------------------
 * Plain-DOM link chips render via `renderHTML` at PM-parse time, which has no React
 * context access. The chip still needs live resolution-state classification —
 * `resolved` / `folder` / `unresolved` / `loading` / `external` — so CSS can drive
 * its visual appearance.
 *
 * Three moving pieces:
 *   1. `markIdentityPlugin` — assigns stable `m${n}` IDs in appendTransaction.
 *   2. `page-list-cache` — module-level store with pages + folderPaths sets,
 *      written by PageListProvider on every render.
 *   3. This plugin — reads `markIdentityPlugin`'s byId + page-list-cache; calls
 *      caller's `computeAttrs(markInfo, cache)`; emits one `Decoration.inline`
 *      per matching mark carrying BOTH `data-mark-id` AND any caller-computed
 *      resolution-state attrs (merged-plugin shape).
 *
 * A consumer installs #1 and #3 together. #3's refresh cadence is:
 *   - Every doc-changing transaction (PM re-runs `props.decorations` unconditionally).
 *   - Every page-list-cache write (handler dispatches a meta transaction that triggers
 *     PM to re-run decorations; the meta itself is a no-op for other plugins because
 *     it is keyed by this plugin's own PluginKey).
 *
 * Consumer pattern
 * ----------------
 *   addProseMirrorPlugins() {
 *     return [
 *       markIdentityPlugin({
 *         markTypes: ['link'],
 *         onRegister: (evt) => getInteractionLayer(editor).register(...),
 *         onDeregister: (evt) => getInteractionLayer(editor).deregister(...),
 *       }),
 *       linkResolutionDecorationPlugin({
 *         markTypes: ['link'],
 *         computeAttrs: (info, cache) => {
 *           const href = info.attrs.href as string | undefined;
 *           if (!href) return null;
 *           return { 'data-resolution-state': resolveLinkState(href, cache) };
 *         },
 *       }),
 *     ];
 *   }
 *
 * Precedent #9 (add-only schema) preserved — no mark attr added or narrowed; the
 * resolution-state lives in decoration attrs only.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mark } from '@/lib/perf';
import {
  getPageListCache,
  type PageListCacheSnapshot,
  subscribePageListCache,
} from '../page-list-cache';
import { type MarkInfo, markIdentityKey } from './mark-identity';
import { MARK_ID_DATA_ATTR } from './mark-identity-decoration';

/**
 * Shape of the plugin's internal state. `version` bumps on every refresh meta so
 * consumers inspecting the plugin state externally can see that a refresh fired
 * even though it doesn't influence the decorations output itself (PM re-runs
 * `props.decorations` whenever plugin state transitions on an apply).
 */
type PluginStateShape = { version: number };

/**
 * PluginKey — exported for state lookup + meta typing.
 */
export const linkResolutionDecorationKey = new PluginKey<PluginStateShape>(
  'linkResolutionDecoration',
);

/**
 * Callback shape — maps `(markInfo, cache)` to an attrs object for the decoration
 * over that mark's range. Return null to skip emitting a decoration for this mark
 * (e.g. when `markInfo.attrs.href` is missing or when the attr set would be empty).
 */
export type LinkResolutionAttrsComputer = (
  markInfo: MarkInfo,
  cache: PageListCacheSnapshot | null,
) => Record<string, string> | null;

interface LinkResolutionDecorationOptions {
  /**
   * Mark type names to decorate. Typically `['link']` for internal-link; could
   * also be `['wikiLink']` if wiki-links ever migrate from node to mark.
   */
  markTypes: readonly string[];
  /**
   * Caller-provided attrs resolver. Receives the latest MarkInfo (with live
   * from/to range) and the current cache snapshot (or null before first write).
   */
  computeAttrs: LinkResolutionAttrsComputer;
}

/**
 * Pure helper — given a byId map + markTypes + cache + computeAttrs, produce the
 * DecorationSet. Exported so tests can exercise the core logic without owning a
 * full EditorState + PluginKey plumbing.
 *
 * Returns null when no decorations would be emitted (mirrors PM's convention for
 * `props.decorations` returning a cheap "nothing to render" signal).
 *
 * Merged-plugin design: every emitted decoration carries `data-mark-id`
 * ALONGSIDE caller-computed resolution-state attrs. Merging the
 * markIdentityDecorationPlugin walk into this one — instead of emitting two
 * stacked Decoration.inline per mark — halves the per-link wrapper-span
 * count.
 *
 * Null-attrs fallback: when `computeAttrs(info, cache)` returns null, the
 * merged decoration STILL emits — carrying just `data-mark-id`. The
 * mark-identity-decoration legacy behavior (every mark gets `data-mark-id`
 * regardless of resolution state) is preserved by this fallback.
 *
 * Precedent #9 add-only schema invariant preserved — no mark schema
 * attributes added; the merge stays at the decoration-attr layer.
 */
export function computeLinkResolutionDecorations(
  doc: PmNode,
  byId: Map<string, MarkInfo>,
  markTypes: ReadonlySet<string>,
  computeAttrs: LinkResolutionAttrsComputer,
  cache: PageListCacheSnapshot | null,
): DecorationSet | null {
  if (byId.size === 0) return null;
  const decos: Decoration[] = [];
  for (const info of byId.values()) {
    if (!markTypes.has(info.markType)) continue;
    const userAttrs = computeAttrs(info, cache);
    // Merged-plugin attrs: data-mark-id always present; caller's resolution
    // state attrs spread on top when computeAttrs returned non-null. Disjoint
    // keys means no overwrite.
    const attrs: Record<string, string> = { [MARK_ID_DATA_ATTR]: info.id };
    if (userAttrs !== null) {
      Object.assign(attrs, userAttrs);
    }
    decos.push(Decoration.inline(info.from, info.to, attrs));
  }
  if (decos.length === 0) return null;
  return DecorationSet.create(doc, decos);
}

/**
 * Plugin factory. Installs state (for refresh-meta version tracking), props
 * (reads markIdentityPlugin's byId + cache; emits decorations), and view (subscribes
 * to page-list-cache; dispatches refresh meta on every cache change; unsubscribes
 * cleanly on plugin destroy).
 *
 * Requires `markIdentityPlugin({ markTypes })` to be installed with overlapping
 * markTypes — otherwise `markIdentityKey.getState(state)` returns null and the
 * decorations function bails out.
 */
export function linkResolutionDecorationPlugin(
  options: LinkResolutionDecorationOptions,
): Plugin<PluginStateShape> {
  const markTypeSet = new Set(options.markTypes);
  const { computeAttrs } = options;

  return new Plugin<PluginStateShape>({
    key: linkResolutionDecorationKey,
    state: {
      init: () => ({ version: 0 }),
      apply(tr, value) {
        const meta = tr.getMeta(linkResolutionDecorationKey);
        if (meta && typeof meta === 'object' && (meta as { refresh?: boolean }).refresh) {
          return { version: value.version + 1 };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        const identity = markIdentityKey.getState(state);
        if (!identity) return null;
        const cache = getPageListCache();
        return computeLinkResolutionDecorations(
          state.doc,
          identity.byId,
          markTypeSet,
          computeAttrs,
          cache,
        );
      },
    },
    view(view) {
      // "Merged plugin active" signal. Single emit per editor mount;
      // visible in DevTools Performance tab so local profiling can confirm
      // the merged plugin is in use.
      mark(
        'ok/render/decoration-merge',
        { markTypes: Array.from(markTypeSet).join(',') },
        { startTime: performance.now(), duration: 0 },
      );
      const unsubscribe = subscribePageListCache(() => {
        view.dispatch(view.state.tr.setMeta(linkResolutionDecorationKey, { refresh: true }));
      });
      return {
        destroy() {
          unsubscribe();
        },
      };
    },
  });
}
