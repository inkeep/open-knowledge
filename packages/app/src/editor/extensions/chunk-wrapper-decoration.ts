/**
 * chunk-wrapper-decoration plugin.
 *
 * Applies `class="ok-chunk-wrapper"` to every top-level direct child of the
 * doc via PM `Decoration.node`. The CSS rule at
 * `globals.css:.ProseMirror .ok-chunk-wrapper` carries
 * `content-visibility: auto` + `contain-intrinsic-size: 0 var(--ok-cv-h, 80px)`,
 * which makes off-viewport blocks structurally skipped by Chromium's
 * containment optimizations.
 *
 * Why per-block (chunk size N=1) instead of grouped chunks
 * --------------------------------------------------------
 * PM's Decoration API has three forms — `inline`, `node`, `widget`. None
 * supports "wrap N consecutive sibling nodes in a shared parent without
 * touching schema." Slate-based editors like Plate use a structural-node
 * chunking model; PM forbids that without a schema change (precedent #9
 * add-only).
 * So we apply CV:auto to each top-level block as its own chunk — chunk
 * size N=1 — and rely on Chromium's implementation handling thousands of
 * CV:auto-classed elements without superlinear overhead.
 *
 * Top-level only: nested elements (text inside paragraph, listItem inside
 * list, tableRow inside tableCell) DON'T get CV:auto, because their parent's
 * containment skip handles them. Walking `state.doc.forEach((node, offset))`
 * gives exactly the top-level direct children.
 *
 * `jsxComponent` exclusion
 * ------------------------
 * `content-visibility: auto` implies `contain: paint`, which clips at the
 * decorated element's border box. `.jsx-component-wrapper` (the DOM node
 * TipTap renders for `jsxComponent`) paints visual chrome OUTSIDE its own
 * border box in three places — the `::before` hover hit-zone at `top:-12px`,
 * the `::after` selection halo at `inset:-4px`, and the `.jsx-component-chrome`
 * toolbar child at `top:-11px` (all in `globals.css` §7/§7a). Decorating these
 * with `.ok-chunk-wrapper` would clip the halo (left/right) and the chrome
 * bar (top), so we skip them. JsxComponent blocks are a small fraction of
 * typical doc content; the layout-work win on the remaining 95%+ of top-level
 * blocks is essentially preserved.
 *
 * Marks
 * -----
 * `ok/render/cv-auto-skip` — fires once per session (module-global flag) on
 * the first decoration emit. The mark is a "track active" signal for
 * DevTools-Performance-tab visibility — one entry per session is sufficient;
 * per-emit would flood the trace.
 *
 * System / config doc safety
 * --------------------------
 * The CLAUDE.md STOP rule "isSystemDoc()/isConfigDoc() gates at every
 * documentName-keyed entry point" doesn't apply directly because this plugin
 * keys off `state.doc` (PM structure), not `documentName`. Safety is enforced
 * upstream:
 *   - `__system__` is rejected at ProviderPool admission and filtered out of
 *     the editor mount list. It never reaches a TiptapEditor instance, so
 *     this plugin's `props.decorations` is never called for it.
 *   - `__config__/workspace` and `__user__/config.yml` use Y.Text-only
 *     Settings-pane transport (CLAUDE.md §STOP rules). No `Y.XmlFragment`
 *     exists for TipTap to bind to, so no editor mount, no plugin call.
 * No in-plugin gate is required.
 *
 * Plugin design
 * -------------
 * `props.decorations` walks `state.doc.forEach` and emits a `Decoration.node`
 * per top-level block child with `class: 'ok-chunk-wrapper'`. PM merges the
 * class with any existing classes the node renders (e.g., heading anchors);
 * the decoration is additive. Inline-only root children are skipped (rare —
 * the doc schema forbids inlines at the root in normal use).
 *
 * The `DecorationSet` is rebuilt on every state transition. PM's diffing
 * means re-emit cost is per-block (the decorations are pure shape; no
 * cached instance). For ~11K top-level blocks this is sub-ms on each
 * transaction.
 *
 * Cross-browser graceful degradation
 * ----------------------------------
 * Browsers that don't support `content-visibility: auto` (Firefox <123,
 * Safari <18) treat the property as unknown and drop it; the CSS rule
 * becomes a no-op. The plugin would then walk the doc and emit decorations
 * on every transaction for no observable benefit (just a stale wrapper
 * class on every top-level block + a per-transaction DOM mutation). The
 * feature-detection short-circuit at module init returns a no-op plugin
 * on those browsers — zero per-transaction CPU, zero unnecessary class
 * attributes in the rendered DOM.
 *
 * SSR / non-browser environments (unit tests with EditorState only) have
 * no `CSS` global; the helper returns `true` there so the plugin still
 * emits decorations for test assertions.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mark } from '@/lib/perf';

export const chunkWrapperDecorationKey = new PluginKey('chunkWrapperDecoration');

export const OK_CHUNK_WRAPPER_CLASS = 'ok-chunk-wrapper';

let firstEmitFired = false;

export function __resetFirstEmitForTesting(): void {
  firstEmitFired = false;
}

function supportsContentVisibilityAuto(): boolean {
  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.supports !== 'function') {
    return true;
  }
  return globalThis.CSS.supports('content-visibility', 'auto');
}

const cvAutoSupported = supportsContentVisibilityAuto();

export function chunkWrapperDecorationPlugin(): Plugin {
  if (!cvAutoSupported) {
    return new Plugin({ key: chunkWrapperDecorationKey });
  }
  return new Plugin({
    key: chunkWrapperDecorationKey,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.forEach((node, pos) => {
          if (node.isInline) return;
          if (node.type.name === 'jsxComponent') return;
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: OK_CHUNK_WRAPPER_CLASS,
            }),
          );
        });
        if (decos.length === 0) return null;
        if (!firstEmitFired) {
          firstEmitFired = true;
          mark(
            'ok/render/cv-auto-skip',
            { chunkCount: decos.length },
            { startTime: performance.now(), duration: 0 },
          );
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
