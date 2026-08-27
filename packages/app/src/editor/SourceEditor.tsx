import { indentWithTab } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { placeholder as cmPlaceholder, EditorView, keymap } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  DEFAULT_LINTER_CONFIG,
  type PersistedLinterConfig,
  toEffectiveBase,
} from '@inkeep/open-knowledge-core';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { OUTLINE_NAV_EVENT, type OutlineNavDetail } from '@/components/OutlinePanel';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import {
  createNestedCMExtensions,
  darkTheme,
  lightTheme,
} from '@/editor/extensions/nested-cm-extensions';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { useConfigContext } from '@/lib/config-provider';
import { editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';
import { claimNoteWindowInitialFocus } from '@/lib/note-window-focus';
import { registerSourceView, unregisterSourceView } from './active-source-view';
import { createSourceClipboardExtension } from './clipboard/index.ts';
import { type CmCacheEntry, mountCmEditor, parkCmEditor } from './editor-cache';
import { useDocLintConfig } from './lint-config-client';
import { startSourceLanding } from './mode-switch-landing';
import { getMountId } from './mount-id-registry';
import { markUserTyping } from './observers';
import { landingFlashSource } from './plugins/landing-flash-source';
import { isUserIntentCmUpdate, requestPreviewTabPromotion } from './preview-tab-promotion';
import { claimScrollerForNavigation, runScrollNavigation } from './scroll-restore-coordination';
import { publishSelectionContext, selectionSnapshotFromSource } from './selection-context';
import {
  publishSelectionStats,
  SELECTION_STATS_DEBOUNCE_MS,
  selectionStatsFromSource,
} from './selection-stats';
import { createSkillPathLinksSourceExtension } from './skill-path-links-source';
import {
  clearPendingSourceNavigation,
  consumePendingSourceNavigation,
  peekPendingSourceNavigation,
} from './source-editor-navigation';
import { sourceHeadingLines } from './source-heading-lines';
import { sourceLineDirection } from './source-line-direction';
import { createLocalTargetDiagnosticsExtension } from './source-lint/local-target-diagnostics';
import { createMarkdownLintExtension } from './source-lint/markdown-lint-source';
import { sourceModeSetup } from './source-mode-setup';
import { createSourcePolishExtension } from './source-polish';
import { attachTypingBurstDetector } from './typing-burst-detector';

// Toolbar exclusion zone in px (= 3.5rem, EditorToolbar's rendered height). CM6
// resolves scrollIntoView with raw scrollTop arithmetic against the ancestor's
// bounding rect and does NOT read `scroll-padding-top` from the scroll ancestor,
// so the `scroll-pt-14` on ScrollPreservingContainer in
// components/EditorActivityPool.tsx does not reach source mode. EditorView.scrollMargins
// is CM6's native equivalent — derive the inset from the same note-window-aware
// helper as the shared scroll container.
// CodeMirror's search config asks for a scroll EFFECT rather than performing
// the scroll, so standing a match-scroll down means handing back an effect no
// extension reads.
const noScrollEffect = StateEffect.define<null>();

interface SourceEditorProps {
  docName: string;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  placeholder?: string;
  isSourceModeActive: boolean;
}

function applyOutlineNavigation(view: EditorView, detail: OutlineNavDetail, docName: string): void {
  // The outline row's index maps 1:1 onto this enumeration, which shares its
  // line-admission rules with the server producer that emitted the row.
  const heading = sourceHeadingLines(view.state.doc)[detail.index];
  if (!heading) return;

  runScrollNavigation(docName, 'outline', () => {
    view.dispatch({
      selection: EditorSelection.cursor(heading.from),
      effects: EditorView.scrollIntoView(heading.from, { y: 'start' }),
    });
    view.focus();
  });
}

export function applyRawMdxNavigation(
  view: EditorView,
  detail: RawMdxNavDetail,
  stillInSourceMode: () => boolean,
  docName: string,
): void {
  requestAnimationFrame(() => {
    // The dispatch is deferred a frame, so the user may flip back to WYSIWYG
    // between scheduling and running. Applying then would move the caret and
    // scroll a now-hidden editor; re-read the live mode and bail if it changed.
    if (!stillInSourceMode()) return;
    const doc = view.state.doc;
    // Clamp offset to doc length (offset may exceed doc length if content
    // differs between Y.Text and originalSpan).
    const pos = Math.min(detail.offset, doc.length);
    runScrollNavigation(docName, 'raw-mdx', () => {
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    });
  });
}

/** Jump to a lint diagnostic's 1-based line/column. Lines/columns are clamped —
 *  the doc may shift between the click and this dispatch.
 *
 *  Returns whether the jump ran. A landing that is itself an explicit navigation
 *  keeps the scroller and this click stands down whole, so a caller holding the
 *  banked intent must keep it for a later replay rather than spend it on a jump
 *  that did not happen. The WYSIWYG half of this seam gates its clear the same
 *  way. */
function applyLintNavigation(view: EditorView, detail: LintNavDetail, docName: string): boolean {
  const doc = view.state.doc;
  const lineNumber = Math.min(Math.max(detail.line, 1), doc.lines);
  const line = doc.line(lineNumber);
  const pos = Math.min(line.from + Math.max(0, detail.column - 1), line.to);
  return runScrollNavigation(docName, 'problems-row', () => {
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      // `y: 'start'` (not 'center'/'nearest'): in full-page source mode the editor
      // renders at content height with no internal scrollport, so CM measures the
      // target as already visible against its own scrollDOM and 'center'/'nearest'
      // never scroll the real ancestor (ScrollPreservingContainer) — the jump
      // silently no-ops whenever the doc overflows the viewport. Top-edge alignment
      // propagates to the ancestor and honors `scrollMargins`, matching the search
      // scrollToMatch + outline-nav fix above.
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    });
    view.focus();
  });
}

export function SourceEditor({
  docName,
  ytext,
  provider,
  placeholder,
  isSourceModeActive,
}: SourceEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Compartments (theme, word-wrap, placeholder) are created in the factory
  // and stored on the cache entry, NOT held per React component. The view
  // outlives this component (cached + reparented), so a
  // per-component compartment is absent from a reused view's config and its
  // reconfigure is a silent no-op — the cached view then keeps a stale value
  // (e.g. the prior theme after a dark/light toggle, or the prior word-wrap
  // setting) once it has been backgrounded and reattached. Module-scope
  // singletons are also wrong here (`createNestedCMExtensions`'s header:
  // "cross-instance reconfigure conflicts" under StrictMode double-mount and
  // the Activity-pool dual-editor pattern) — per-entry is the correct scope:
  // exactly one compartment per view, reachable via `cmEntryRef.current`.
  //
  // Mount failures rethrow into DocumentErrorBoundary.
  const [mountError, setMountError] = useState<Error | null>(null);
  if (mountError) throw mountError;
  const { resolvedTheme } = useTheme();
  const { merged } = useConfigContext();
  const sourceModeActiveRef = useRef(isSourceModeActive);
  const wordWrap = merged?.editor?.wordWrap ?? true;
  // Markdown-linter config. The EFFECTIVE config for this doc (project base +
  // native `.markdownlint.*` rules) comes from the server; fall back to the
  // project config from the config CRDT while it loads / on error. Like
  // theme/wordWrap, it's applied via a Compartment reconfigure (no remount); the
  // serialized key is the reconfigure effect's dependency.
  const { data: lintConfigData } = useDocLintConfig(docName);
  // The server `effective` already carries native-file markdownlint `rules`. The
  // persisted-config fallback omits them, so lift it through `toEffectiveBase`
  // (seeds empty `rules`) until the server config resolves.
  const linterConfig =
    lintConfigData?.effective ??
    (merged?.contentRules
      ? toEffectiveBase(merged.contentRules as unknown as PersistedLinterConfig)
      : DEFAULT_LINTER_CONFIG);
  const linterConfigKey = JSON.stringify(linterConfig);

  useEffect(() => {
    sourceModeActiveRef.current = isSourceModeActive;
  }, [isSourceModeActive]);

  // Awareness `mode` is published by TiptapEditor (single writer), driven by
  // the same `isSourceMode` prop. SourceEditor reads only — it doesn't write
  // awareness — to prevent two writers from racing (peers' observed mode
  // would otherwise depend on React's effect-firing order across siblings,
  // and after a navigate-away clear (setLocalState(null)) SourceEditor's
  // setLocalStateField would no-op while TiptapEditor's setLocalState
  // rebuilt the entry).

  // EDITOR CACHE WIRING
  //
  // Replaces the inline `new EditorView({ parent })` + `view.destroy()` on
  // unmount with mountCmEditor + parkCmEditor. The view's DOM is reparented across Activity flips instead of
  // being destroyed, which preserves selection / undo / yCollab binding /
  // Y.Text identity / scroll position.
  //
  // Cache key is the docName from provider.configuration.name — same key
  // EditorActivityPool uses for setActivityMountList. Park never destroys;
  // only evictCmEditor (LRU) does.
  //
  // The DOM listener for markUserTyping attaches to the cached
  // view's contentDOM exactly once per editor lifetime — the listeners
  // survive reparent (W3C spec). On park
  // they remain wired; on evict the editor.destroy() in evictCmEditor
  // removes them with the contentDOM.
  //
  // resolvedTheme and wordWrap are intentionally excluded from the deps array
  // below — later effects reconfigure their Compartments on change. Adding
  // either here would trigger a full editor remount for settings changes,
  // which is exactly what Compartments are for.
  const cmEntryRef = useRef<CmCacheEntry | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resolvedDocName = provider.configuration.name ?? '';

    let entry: CmCacheEntry | null = null;
    const mark = () => markUserTyping();

    try {
      // Size-aware cache gate driven at the consumer call site. CM6 has no
      // per-view expensive NodeView concept so viewCount=0 is accurate
      // (not an approximation); the bytes gate is the sole protection for
      // multi-MB docs.
      const bytes = ytext.length;
      const sizeStats = { viewCount: 0, bytes };
      entry = mountCmEditor({
        docName: resolvedDocName,
        container,
        sizeStats,
        factory: (el) => {
          // Source clipboard: copy writes both text/plain markdown AND
          // text/html source-shaped HTML; paste preserves raw text/plain for
          // source-editor payloads and only converts generic rich HTML.
          // Trailing-debounced selection-stats publish; the timer lives with
          // the view (cached across Activity park/reparent).
          let selectionStatsTimer: ReturnType<typeof setTimeout> | null = null;
          const sourceClipboard = createSourceClipboardExtension({
            ydoc: provider.document,
            ytext,
            docName: resolvedDocName,
          });
          // Created here (not as component refs) so they live with the cached
          // view — see the compartment note above and `CmCacheEntry`.
          const themeCompartment = new Compartment();
          const wordWrapCompartment = new Compartment();
          const placeholderCompartment = new Compartment();
          const lintCompartment = new Compartment();
          const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
              sourceModeSetup,
              sourceLineDirection,
              // Search-result scroll. CM's default search `scrollToMatch` is
              // `EditorView.scrollIntoView(range)` (y:'nearest'), which no-ops in
              // full-page source mode: the editor renders at content height with no
              // internal scrollport, so CM measures the match as already visible
              // against its own scrollDOM and never scrolls the real ancestor
              // (ScrollPreservingContainer). y:'start' forces a top-edge alignment
              // that propagates to the ancestor and honors `scrollMargins` below, so a
              // found offscreen match lands just under the toolbar instead of staying
              // out of view. Drives every search entry point (Enter, Cmd+G, F3,
              // next/prev) since they all route through `config.scrollToMatch`.
              //
              // A match is an explicit navigation, so it claims the scroller from
              // an in-flight mode-switch landing first — without that, a search
              // run inside a landing's settle window scrolls and is reset to the
              // landing's own target milliseconds later.
              search({
                scrollToMatch: (range) =>
                  claimScrollerForNavigation(resolvedDocName, 'find-match')
                    ? EditorView.scrollIntoView(range, { y: 'start' })
                    : noScrollEffect.of(null),
              }),
              // Tab inserts indentation instead of escaping focus. CM6's default is
              // to let Tab move focus (WCAG "no keyboard trap") — for a code-style
              // editor this is unexpected UX. Users who need to escape focus can
              // press Esc → Tab, or Ctrl+M (Shift+Alt+M on macOS) to toggle tab-
              // focus mode. Upstream convention per codemirror.net/examples/tab/.
              keymap.of([indentWithTab]),
              yCollab(ytext, provider.awareness),
              // Route Mod-z/Mod-y to the y-codemirror Y.UndoManager (origin-aware,
              // remote/agent writes excluded) instead of CodeMirror's native
              // history, which sourceModeSetup omits.
              keymap.of(yUndoManagerKeymap),
              // Nested-CM / SourceEditor convergence: the factory provides markdown
              // (with GFM + codeLanguages), wiki-link + md-link decorations,
              // agent-flash, theme compartment, line-wrapping. Source mode adds the
              // extras below (source-polish, placeholder, full-height theme).
              ...createNestedCMExtensions({
                themeCompartment,
                resolvedTheme,
                ydoc: provider.document,
                wordWrapCompartment,
                wordWrap,
                currentDocName: resolvedDocName,
              }),
              createSourcePolishExtension(),
              // Skill docs: backticked bundle paths are clickable (shared
              // contract with the WYSIWYG extension; no-op for normal docs).
              createSkillPathLinksSourceExtension(resolvedDocName),
              // Transient highlight for a mode-switch jump that lands in source.
              landingFlashSource(),
              lintCompartment.of(createMarkdownLintExtension(linterConfig, docName)),
              // Server-authoritative target-existence diagnostics (missing local
              // files/images/documents + reference-style targets). Separate from
              // the markdownlint compartment above: it follows `validation.links`
              // server-side, not the markdownlint enabled flag, and fetches its
              // own findings rather than re-linting off the doc text.
              createLocalTargetDiagnosticsExtension(docName),
              sourceClipboard,
              // A user edit promotes this doc's preview tab to permanent. Safe to
              // capture `resolvedDocName` in the closure even though the view
              // outlives this component: the view is bound to one doc's Y.Text
              // for its whole lifetime, and the promotion itself is dispatched
              // through a module-level listener rather than a captured callback.
              EditorView.updateListener.of((update) => {
                if (!isUserIntentCmUpdate(update)) return;
                requestPreviewTabPromotion(resolvedDocName);
              }),
              EditorView.updateListener.of((update) => {
                if (!update.selectionSet && !update.docChanged) return;
                if (selectionStatsTimer !== null) clearTimeout(selectionStatsTimer);
                selectionStatsTimer = setTimeout(() => {
                  selectionStatsTimer = null;
                  publishSelectionStats(
                    resolvedDocName,
                    'source',
                    selectionStatsFromSource(update.view),
                  );
                  publishSelectionContext(
                    resolvedDocName,
                    'source',
                    selectionSnapshotFromSource(update.view, resolvedDocName),
                  );
                }, SELECTION_STATS_DEBOUNCE_MS);
              }),
              placeholderCompartment.of(cmPlaceholder(placeholder ?? '')),
              EditorView.theme({
                '&': {
                  height: '100%',
                },
              }),
              EditorView.scrollMargins.of(() => ({ top: editorToolbarOverlapPx() })),
            ],
          });
          const view = new EditorView({ state, parent: el });
          // Seed the initial selection-stats entry (usually null) — also clears
          // a stale entry left by a prior evicted editor for this docName.
          publishSelectionStats(resolvedDocName, 'source', selectionStatsFromSource(view));
          publishSelectionContext(
            resolvedDocName,
            'source',
            selectionSnapshotFromSource(view, resolvedDocName),
          );
          // Wire markUserTyping listeners on first construction. They survive
          // reparent (W3C MutationObserver / addEventListener bind to the DOM
          // node, not its position).
          const dom = view.contentDOM;
          dom.addEventListener('keydown', mark);
          dom.addEventListener('paste', mark);
          dom.addEventListener('drop', mark);
          dom.addEventListener('cut', mark);
          return {
            view,
            ydoc: provider.document,
            ytext,
            provider,
            themeCompartment,
            wordWrapCompartment,
            placeholderCompartment,
            lintCompartment,
          };
        },
      });
      cmEntryRef.current = entry;
      viewRef.current = entry.view;
      // Publish the live view so a source-to-WYSIWYG flip can read its viewport
      // synchronously at flip time, before this editor is hidden, and so outline
      // active-heading tracking can measure this document's line geometry.
      registerSourceView(docName, entry.view);
      // A popped-out note window has nothing else to focus, so the first editor
      // surface to mount takes the caret. One-shot per window: later mounts
      // (Activity reveal, mode flip) must not yank focus back mid-session.
      if (claimNoteWindowInitialFocus()) entry.view.focus();
    } catch (err) {
      // Surface mount failures through DocumentErrorBoundary.
      console.error('[SourceEditor] mountCmEditor failed', err);
      cmEntryRef.current = null;
      viewRef.current = null;
      setMountError(err instanceof Error ? err : new Error(String(err)));
    }

    return () => {
      const cur = cmEntryRef.current;
      if (cur) {
        parkCmEditor(cur);
        // A parked view is off screen, so it must stop answering geometry
        // questions for this document even though the view itself stays alive.
        unregisterSourceView(docName, cur.view);
      }
      // Listener cleanup is implicit when evictCmEditor calls view.destroy().
      // We do NOT remove listeners here because the view is still alive in
      // the cache (just parked).
      cmEntryRef.current = null;
      viewRef.current = null;
    };
    // `placeholder` is intentionally NOT in the deps array. The separate
    // effect below uses `placeholderCompartment.reconfigure` to hot-swap the
    // placeholder text without tearing down the view — including `placeholder`
    // here would defeat that by triggering a full park+remount on every
    // placeholder change.
  }, [ytext, provider]);

  // Per-burst typing detector wire-site. Tree-shakes from prod via the
  // dead-branch gate.
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const view = viewRef.current;
    if (!view) return;
    const mountId = getMountId(docName);
    if (!mountId) return;
    const sampler = attachTypingBurstDetector({
      mode: 'Source',
      docName,
      mountId,
    });
    const updateExtension = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // Origin gate: y-codemirror.next reflects Y.js sync transactions
      // back into CodeMirror with a transaction that has `userEvent` set
      // to a Y-prefixed event when triggered by remote sync. We use the
      // structural property `transactions[i].annotation(Transaction.userEvent)`
      // — but for a coarse substrate the simpler heuristic is "this
      // update was synthetic if any transaction is sync-origin," and
      // y-codemirror omits userEvent annotations on its dispatched
      // transactions. Conservative: count net changes, and let the
      // upstream consumer refine if cardinality becomes load-bearing.
      // Substrate accepts user input only — programmatic sync paths
      // already drive zero charsTyped because they don't set userEvent.
      let charsDelta = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        charsDelta += inserted.length - (toA - fromA);
      });
      if (charsDelta === 0) return;
      sampler.recordUserInput(0, charsDelta);
    });
    // Reconfigure-time-attach is heavy; we hot-attach via a Compartment
    // would be cleaner. For DEV-only the detector module is dead in
    // prod so the simplest thing is fine: dispatch a state-effect that
    // re-installs the listener — but in practice we can attach via
    // view.dom event listeners as a substrate-coarse alternative.
    const onInput = () => sampler.recordUserInput(0, 1);
    view.dom.addEventListener('input', onInput);
    // Suppress the unused-extension lint by referencing the constructor
    // — this keeps the symbol live for future Compartment-based wire.
    void updateExtension;
    return () => {
      view.dom.removeEventListener('input', onInput);
      sampler.detach();
    };
  }, [docName]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    // Reconfigure the theme via the compartment stored ON THE CACHE ENTRY, not
    // a per-component ref. This effect also runs on every mount (after the
    // mount effect sets cmEntryRef), so a cache-hit reattach re-applies the
    // CURRENT theme — repairing a view that was built under one theme and
    // toggled while backgrounded. Targeting a per-component compartment here
    // would no-op against the reused view and leave it on the stale theme.
    entry.view.dispatch({
      effects: entry.themeCompartment.reconfigure(
        resolvedTheme === 'dark' ? darkTheme : lightTheme,
      ),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    // Reconfigure via the cache-entry compartment (runs on mount too), so a
    // cache-hit reattach re-applies the current word-wrap setting instead of
    // keeping whatever the view was built with. See the compartment note above.
    entry.view.dispatch({
      effects: entry.wordWrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    entry.view.dispatch({
      effects: entry.placeholderCompartment.reconfigure(cmPlaceholder(placeholder ?? '')),
    });
  }, [placeholder]);

  // Re-apply the linter config (rule toggles + the enabled flag) via the
  // cache-entry compartment. Runs on mount too, so a cache-hit reattach
  // re-lints under the current config. `linterConfigKey` (serialized config)
  // is the dependency — the object identity is unstable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: linterConfig is keyed by linterConfigKey
  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    entry.view.dispatch({
      effects: entry.lintCompartment.reconfigure(
        createMarkdownLintExtension(linterConfig, docName),
      ),
    });
  }, [linterConfigKey]);

  // Outline panel click → jump to the Nth heading line in the CodeMirror doc.
  useEffect(() => {
    function onNav(e: Event) {
      const detail = (e as CustomEvent<OutlineNavDetail>).detail;
      if (!detail || detail.docName !== docName || detail.mode !== 'source' || !isSourceModeActive)
        return;
      const view = viewRef.current;
      if (!view) return;
      applyOutlineNavigation(view, detail, docName);
      clearPendingSourceNavigation(docName);
    }
    window.addEventListener(OUTLINE_NAV_EVENT, onNav);
    return () => window.removeEventListener(OUTLINE_NAV_EVENT, onNav);
  }, [docName, isSourceModeActive]);

  // Problems panel click → jump to the diagnostic's line in the CodeMirror doc.
  useEffect(() => {
    function onLintNav(e: Event) {
      const detail = (e as CustomEvent<LintNavDetail>).detail;
      if (!detail || detail.docName !== docName || !isSourceModeActive) return;
      const view = viewRef.current;
      if (!view) return;
      if (applyLintNavigation(view, detail, docName)) clearPendingSourceNavigation(docName);
    }
    window.addEventListener(LINT_NAV_EVENT, onLintNav);
    return () => window.removeEventListener(LINT_NAV_EVENT, onLintNav);
  }, [docName, isSourceModeActive]);

  // Replays the most recent source-navigation intent once the editor chunk is
  // mounted and visible for this doc. This preserves first-open raw-MDX and
  // outline jumps even when SourceEditor was lazy-loaded off the initial path.
  useEffect(() => {
    if (!isSourceModeActive) return;
    const view = viewRef.current;
    if (!view) return;

    const pendingNavigation = peekPendingSourceNavigation(docName);
    if (!pendingNavigation) return;

    // The one-shot navs apply synchronously and consume their entry; re-running
    // this effect (a StrictMode mount is invoked twice) simply finds nothing left.
    if (pendingNavigation.kind !== 'selection-offset') {
      consumePendingSourceNavigation(docName);
      if (pendingNavigation.kind === 'outline') {
        applyOutlineNavigation(view, pendingNavigation.detail, docName);
      } else if (pendingNavigation.kind === 'lint') {
        applyLintNavigation(view, pendingNavigation.detail, docName);
      } else if (pendingNavigation.kind === 'raw-mdx') {
        applyRawMdxNavigation(
          view,
          pendingNavigation.detail,
          () => sourceModeActiveRef.current,
          docName,
        );
      }
      return;
    }

    // The cross-mode landing runs through the settle contract instead of a
    // one-shot scroll, so it hands back a handle the cleanup cancels if the mode
    // flips away (or the doc changes) before it settles. Because that cleanup
    // cancels — and a cancelled landing is discarded without settling — starting
    // it synchronously here loses the whole landing to the immediate
    // mount→cleanup→remount a StrictMode mount performs. Deferring the consume
    // and start to a microtask lets that synchronous cycle finish first; only the
    // surviving closure's callback runs, so the landing starts once and settles.
    let cancelled = false;
    let landing: ReturnType<typeof startSourceLanding> = null;
    queueMicrotask(() => {
      if (cancelled) return;
      const navigation = peekPendingSourceNavigation(docName);
      if (navigation?.kind !== 'selection-offset') return;
      landing = startSourceLanding({
        view,
        docName,
        navigation,
        ydoc: provider.document,
        transition: { from: 'wysiwyg', to: 'source' },
      });
      // Consume only once a landing actually started. `startSourceLanding`
      // declines when the WYSIWYG doc it grades against is not mounted (a large
      // document that deferred it), and consuming first would drop the user's
      // jump target for good — leaving it banked lets a later entry replay it
      // inside its TTL. A landing that did start owns the entry from here: its
      // own cancel path discards it.
      if (landing) consumePendingSourceNavigation(docName);
    });
    return () => {
      cancelled = true;
      landing?.cancel('mode-flip');
    };
  }, [docName, isSourceModeActive, provider]);

  return <div ref={containerRef} className="source-editor h-full pb-3" />;
}
