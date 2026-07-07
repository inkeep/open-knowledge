import { indentWithTab } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { placeholder as cmPlaceholder, EditorView, keymap } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { createCodeFenceTracker } from '@inkeep/open-knowledge-core';
import { isMacOS } from '@tiptap/core';
import { basicSetup } from 'codemirror';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { emitOpenAskAiComposer } from '@/components/ask-ai-composer-events';
import { OUTLINE_NAV_EVENT, type OutlineNavDetail } from '@/components/OutlinePanel';
import {
  createNestedCMExtensions,
  darkTheme,
  lightTheme,
} from '@/editor/extensions/nested-cm-extensions';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { useConfigContext } from '@/lib/config-provider';
import { matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { createSourceClipboardExtension } from './clipboard/index.ts';
import { type CmCacheEntry, mountCmEditor, parkCmEditor } from './editor-cache';
import { getMountId } from './mount-id-registry';
import { markUserTyping } from './observers';
import { publishSelectionContext, selectionSnapshotFromSource } from './selection-context';
import {
  publishSelectionStats,
  SELECTION_STATS_DEBOUNCE_MS,
  selectionStatsFromSource,
} from './selection-stats';
import {
  clearPendingSourceNavigation,
  consumePendingSourceNavigation,
} from './source-editor-navigation';
import { createSourcePolishExtension } from './source-polish';
import { FM_FENCE_LINE_RE } from './source-polish/view-plugin';
import { attachTypingBurstDetector } from './typing-burst-detector';

// Toolbar exclusion zone in px (= 3.5rem, EditorToolbar's rendered height). CM6
// resolves scrollIntoView with raw scrollTop arithmetic against the ancestor's
// bounding rect and does NOT read `scroll-padding-top` from the scroll ancestor,
// so the `scroll-pt-14` on ScrollPreservingContainer in
// components/EditorActivityPool.tsx does not reach source mode. EditorView.scrollMargins
// is CM6's native equivalent — restate the inset here. Keep in sync with `pt-14`
// / `scroll-pt-14` in components/EditorActivityPool.tsx; rendered height from
// components/EditorToolbar.tsx.
const TOOLBAR_OVERLAP_PX = 56;

interface SourceEditorProps {
  docName: string;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  placeholder?: string;
  isSourceModeActive: boolean;
}

function applyOutlineNavigation(view: EditorView, detail: OutlineNavDetail): void {
  const doc = view.state.doc;
  let startLine = 1;
  // FM fence recognition must agree with the server's extractHeadings (core
  // fence contract), which produces the outline this index maps onto —
  // otherwise YAML `#` lines shift the heading count and clicks jump wrong.
  if (doc.lines >= 1 && FM_FENCE_LINE_RE.test(doc.line(1).text)) {
    for (let i = 2; i <= doc.lines; i++) {
      if (FM_FENCE_LINE_RE.test(doc.line(i).text)) {
        startLine = i + 1;
        break;
      }
    }
  }

  // Skip `#` comments inside fenced code blocks — they render as code, not
  // headings, so they must stay out of the heading count that maps 1:1 onto
  // the outline index.
  const isInCodeFence = createCodeFenceTracker();
  let seen = 0;
  for (let i = startLine; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (isInCodeFence(line.text)) continue;
    if (/^#{1,6}\s/.test(line.text)) {
      if (seen === detail.index) {
        view.dispatch({
          selection: EditorSelection.cursor(line.from),
          effects: EditorView.scrollIntoView(line.from, { y: 'start' }),
        });
        view.focus();
        return;
      }
      seen++;
    }
  }
}

function applyRawMdxNavigation(view: EditorView, detail: RawMdxNavDetail): void {
  requestAnimationFrame(() => {
    const doc = view.state.doc;
    // Clamp offset to doc length (offset may exceed doc length if content
    // differs between Y.Text and originalSpan).
    const pos = Math.min(detail.offset, doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
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
          });
          // Created here (not as component refs) so they live with the cached
          // view — see the compartment note above and `CmCacheEntry`.
          const themeCompartment = new Compartment();
          const wordWrapCompartment = new Compartment();
          const placeholderCompartment = new Compartment();
          const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
              basicSetup,
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
              search({
                scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'start' }),
              }),
              // Tab inserts indentation instead of escaping focus. CM6's default is
              // to let Tab move focus (WCAG "no keyboard trap") — for a code-style
              // editor this is unexpected UX. Users who need to escape focus can
              // press Esc → Tab, or Ctrl+M (Shift+Alt+M on macOS) to toggle tab-
              // focus mode. Upstream convention per codemirror.net/examples/tab/.
              keymap.of([indentWithTab]),
              yCollab(ytext, provider.awareness),
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
              sourceClipboard,
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
              EditorView.domEventHandlers({
                keydown: (event, _view) => {
                  if (!sourceModeActiveRef.current) return false;
                  if (!isMacOS()) return false;
                  if (!matchesKeyboardShortcut(event, 'edit-with-ai')) return false;
                  event.preventDefault();
                  event.stopPropagation();
                  event.stopImmediatePropagation();
                  emitOpenAskAiComposer();
                  return true;
                },
              }),
              placeholderCompartment.of(cmPlaceholder(placeholder ?? '')),
              EditorView.theme({
                '&': {
                  height: '100%',
                },
              }),
              EditorView.scrollMargins.of(() => ({ top: TOOLBAR_OVERLAP_PX })),
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
          };
        },
      });
      cmEntryRef.current = entry;
      viewRef.current = entry.view;
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

  // Outline panel click → jump to the Nth heading line in the CodeMirror doc.
  useEffect(() => {
    function onNav(e: Event) {
      const detail = (e as CustomEvent<OutlineNavDetail>).detail;
      if (!detail || detail.mode !== 'source' || !isSourceModeActive) return;
      const view = viewRef.current;
      if (!view) return;
      applyOutlineNavigation(view, detail);
      clearPendingSourceNavigation(docName);
    }
    window.addEventListener(OUTLINE_NAV_EVENT, onNav);
    return () => window.removeEventListener(OUTLINE_NAV_EVENT, onNav);
  }, [docName, isSourceModeActive]);

  // Replays the most recent source-navigation intent once the editor chunk is
  // mounted and visible for this doc. This preserves first-open raw-MDX and
  // outline jumps even when SourceEditor was lazy-loaded off the initial path.
  useEffect(() => {
    if (!isSourceModeActive) return;
    const view = viewRef.current;
    if (!view) return;

    const pendingNavigation = consumePendingSourceNavigation(docName);
    if (!pendingNavigation) return;

    if (pendingNavigation.kind === 'outline') {
      applyOutlineNavigation(view, pendingNavigation.detail);
      return;
    }

    applyRawMdxNavigation(view, pendingNavigation.detail);
  }, [docName, isSourceModeActive]);

  return <div ref={containerRef} className="source-editor h-full pb-3" />;
}
