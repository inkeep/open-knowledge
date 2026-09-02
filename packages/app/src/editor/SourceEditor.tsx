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
import {
  OUTLINE_NAV_BREADCRUMB,
  OUTLINE_NAV_EVENT,
  type OutlineNavDetail,
} from '@/components/OutlinePanel';
import { LINT_NAV_EVENT, type LintNavDetail } from '@/components/ProblemsPanel';
import {
  createNestedCMExtensions,
  darkTheme,
  lightTheme,
} from '@/editor/extensions/nested-cm-extensions';
import type { RawMdxNavDetail } from '@/editor/extensions/raw-mdx-nav-event';
import { useConfigContext } from '@/lib/config-provider';
import { emitDiagnosticBreadcrumb } from '@/lib/diagnostic-breadcrumb';
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

const noScrollEffect = StateEffect.define<null>();

interface SourceEditorProps {
  docName: string;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  placeholder?: string;
  isSourceModeActive: boolean;
}

function applyOutlineNavigation(view: EditorView, detail: OutlineNavDetail, docName: string): void {
  const lines = sourceHeadingLines(view.state.doc);
  const heading = lines[detail.index];
  const trace = {
    docName,
    mode: 'source',
    index: detail.index,
    sourceHeadingCount: lines.length,
  };
  if (!heading) {
    emitDiagnosticBreadcrumb(OUTLINE_NAV_BREADCRUMB, { ...trace, outcome: 'no-target' });
    return;
  }

  const claimed = runScrollNavigation(docName, 'outline', () => {
    view.dispatch({
      selection: EditorSelection.cursor(heading.from),
      effects: EditorView.scrollIntoView(heading.from, { y: 'start' }),
    });
    view.focus();
  });
  emitDiagnosticBreadcrumb(OUTLINE_NAV_BREADCRUMB, {
    ...trace,
    outcome: claimed ? 'scrolled' : 'declined',
    targetLine: view.state.doc.lineAt(heading.from).number,
  });
}

export function applyRawMdxNavigation(
  view: EditorView,
  detail: RawMdxNavDetail,
  stillInSourceMode: () => boolean,
  docName: string,
): void {
  requestAnimationFrame(() => {
    if (!stillInSourceMode()) return;
    const doc = view.state.doc;
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

function applyLintNavigation(view: EditorView, detail: LintNavDetail, docName: string): boolean {
  const doc = view.state.doc;
  const lineNumber = Math.min(Math.max(detail.line, 1), doc.lines);
  const line = doc.line(lineNumber);
  const pos = Math.min(line.from + Math.max(0, detail.column - 1), line.to);
  return runScrollNavigation(docName, 'problems-row', () => {
    view.dispatch({
      selection: EditorSelection.cursor(pos),
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
  const [mountError, setMountError] = useState<Error | null>(null);
  if (mountError) throw mountError;
  const { resolvedTheme } = useTheme();
  const { merged } = useConfigContext();
  const sourceModeActiveRef = useRef(isSourceModeActive);
  const wordWrap = merged?.editor?.wordWrap ?? true;
  const { data: lintConfigData } = useDocLintConfig(docName);
  const linterConfig =
    lintConfigData?.effective ??
    (merged?.contentRules
      ? toEffectiveBase(merged.contentRules as unknown as PersistedLinterConfig)
      : DEFAULT_LINTER_CONFIG);
  const linterConfigKey = JSON.stringify(linterConfig);

  useEffect(() => {
    sourceModeActiveRef.current = isSourceModeActive;
  }, [isSourceModeActive]);

  const cmEntryRef = useRef<CmCacheEntry | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const resolvedDocName = provider.configuration.name ?? '';

    let entry: CmCacheEntry | null = null;
    const mark = () => markUserTyping();

    try {
      const bytes = ytext.length;
      const sizeStats = { viewCount: 0, bytes };
      entry = mountCmEditor({
        docName: resolvedDocName,
        container,
        sizeStats,
        factory: (el) => {
          let selectionStatsTimer: ReturnType<typeof setTimeout> | null = null;
          const sourceClipboard = createSourceClipboardExtension({
            ydoc: provider.document,
            ytext,
            docName: resolvedDocName,
          });
          const themeCompartment = new Compartment();
          const wordWrapCompartment = new Compartment();
          const placeholderCompartment = new Compartment();
          const lintCompartment = new Compartment();
          const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
              sourceModeSetup,
              sourceLineDirection,
              search({
                scrollToMatch: (range) =>
                  claimScrollerForNavigation(resolvedDocName, 'find-match')
                    ? EditorView.scrollIntoView(range, { y: 'start' })
                    : noScrollEffect.of(null),
              }),
              keymap.of([indentWithTab]),
              yCollab(ytext, provider.awareness),
              keymap.of(yUndoManagerKeymap),
              ...createNestedCMExtensions({
                themeCompartment,
                resolvedTheme,
                ydoc: provider.document,
                wordWrapCompartment,
                wordWrap,
                currentDocName: resolvedDocName,
              }),
              createSourcePolishExtension(),
              createSkillPathLinksSourceExtension(resolvedDocName),
              landingFlashSource(),
              lintCompartment.of(createMarkdownLintExtension(linterConfig, docName)),
              createLocalTargetDiagnosticsExtension(docName),
              sourceClipboard,
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
          publishSelectionStats(resolvedDocName, 'source', selectionStatsFromSource(view));
          publishSelectionContext(
            resolvedDocName,
            'source',
            selectionSnapshotFromSource(view, resolvedDocName),
          );
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
      registerSourceView(docName, entry.view);
      if (claimNoteWindowInitialFocus()) entry.view.focus();
    } catch (err) {
      console.error('[SourceEditor] mountCmEditor failed', err);
      cmEntryRef.current = null;
      viewRef.current = null;
      setMountError(err instanceof Error ? err : new Error(String(err)));
    }

    return () => {
      const cur = cmEntryRef.current;
      if (cur) {
        parkCmEditor(cur);
        unregisterSourceView(docName, cur.view);
      }
      cmEntryRef.current = null;
      viewRef.current = null;
    };
  }, [ytext, provider]);

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
      let charsDelta = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        charsDelta += inserted.length - (toA - fromA);
      });
      if (charsDelta === 0) return;
      sampler.recordUserInput(0, charsDelta);
    });
    const onInput = () => sampler.recordUserInput(0, 1);
    view.dom.addEventListener('input', onInput);
    void updateExtension;
    return () => {
      view.dom.removeEventListener('input', onInput);
      sampler.detach();
    };
  }, [docName]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    entry.view.dispatch({
      effects: entry.themeCompartment.reconfigure(
        resolvedTheme === 'dark' ? darkTheme : lightTheme,
      ),
    });
  }, [resolvedTheme]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
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

  useEffect(() => {
    function onNav(e: Event) {
      const detail = (e as CustomEvent<OutlineNavDetail>).detail;
      if (!detail || detail.docName !== docName || detail.mode !== 'source' || !isSourceModeActive)
        return;
      const view = viewRef.current;
      if (!view) {
        emitDiagnosticBreadcrumb(OUTLINE_NAV_BREADCRUMB, {
          docName,
          mode: 'source',
          index: detail.index,
          outcome: 'no-view',
        });
        return;
      }
      applyOutlineNavigation(view, detail, docName);
      clearPendingSourceNavigation(docName);
    }
    window.addEventListener(OUTLINE_NAV_EVENT, onNav);
    return () => window.removeEventListener(OUTLINE_NAV_EVENT, onNav);
  }, [docName, isSourceModeActive]);

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

  useEffect(() => {
    if (!isSourceModeActive) return;
    const view = viewRef.current;
    if (!view) return;

    const pendingNavigation = peekPendingSourceNavigation(docName);
    if (!pendingNavigation) return;

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
      if (landing) consumePendingSourceNavigation(docName);
    });
    return () => {
      cancelled = true;
      landing?.cancel('mode-flip');
    };
  }, [docName, isSourceModeActive, provider]);

  return <div ref={containerRef} className="source-editor h-full pb-3" />;
}
