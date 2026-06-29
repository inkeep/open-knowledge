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
  if (doc.lines >= 1 && FM_FENCE_LINE_RE.test(doc.line(1).text)) {
    for (let i = 2; i <= doc.lines; i++) {
      if (FM_FENCE_LINE_RE.test(doc.line(i).text)) {
        startLine = i + 1;
        break;
      }
    }
  }

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
  const [mountError, setMountError] = useState<Error | null>(null);
  if (mountError) throw mountError;
  const { resolvedTheme } = useTheme();
  const { merged } = useConfigContext();
  const sourceModeActiveRef = useRef(isSourceModeActive);
  const wordWrap = merged?.editor?.wordWrap ?? true;

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
          });
          const themeCompartment = new Compartment();
          const wordWrapCompartment = new Compartment();
          const placeholderCompartment = new Compartment();
          const state = EditorState.create({
            doc: ytext.toString(),
            extensions: [
              basicSetup,
              search({
                scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: 'start' }),
              }),
              keymap.of([indentWithTab]),
              yCollab(ytext, provider.awareness),
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
          };
        },
      });
      cmEntryRef.current = entry;
      viewRef.current = entry.view;
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
