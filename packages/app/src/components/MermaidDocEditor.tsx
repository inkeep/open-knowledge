/**
 * Mounted by `EditorActivityPool` inside the doc's `DocumentBoundary` (peer to the conflict
 * `DiffViewBoundary` branch), so `provider` is sync-gated and the precedent #18(b) hybrid render
 * tree is preserved.
 */

import { syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { basicSetup } from 'codemirror';
import { mermaid } from 'codemirror-lang-mermaid';
import { useTheme } from 'next-themes';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import {
  codeMirrorContentAttributes,
  relabelCodeMirrorContent,
} from '@/editor/code-mirror-content-attributes';
import { propEditorHighlight } from '@/editor/components/CodeMirrorPropInput';
import { type MermaidSourceBinding, MermaidView } from '@/editor/components/Mermaid';
import { type CmCacheEntry, mountCmEditor, parkCmEditor } from '@/editor/editor-cache';
import { okCmTheme } from '@/editor/extensions/cm-theme';
import { registerFullPageCmView, unregisterFullPageCmView } from '@/editor/full-page-cm-views';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { acquireDocUndoManager } from './doc-undo-manager';

const darkTheme = okCmTheme({
  dark: true,
  background: 'var(--background)',
  gutterBackground: 'var(--muted)',
});
const lightTheme = okCmTheme({
  dark: false,
  background: 'var(--background)',
  gutterBackground: 'var(--muted)',
});

const lastScrollSnapshots = new WeakMap<
  EditorView,
  ReturnType<EditorView['scrollSnapshot']> | undefined
>();

const mapScrollSnapshotThroughEdits = EditorView.updateListener.of((update) => {
  const snapshot = lastScrollSnapshots.get(update.view);
  if (snapshot && update.docChanged) {
    lastScrollSnapshots.set(update.view, snapshot.map(update.changes));
  }
});

export function replaceYText(ytext: Y.Text, next: string, origin?: unknown): void {
  const current = ytext.toString();
  if (current === next) return;
  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current[start] === next[start]) start += 1;
  let endCur = current.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && current[endCur - 1] === next[endNext - 1]) {
    endCur -= 1;
    endNext -= 1;
  }
  const apply = () => {
    if (endCur > start) ytext.delete(start, endCur - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  };
  const doc = ytext.doc;
  if (doc) doc.transact(apply, origin);
  else apply();
}

function MermaidSourcePane({
  contentLabel,
  docName,
  ytext,
  provider,
  undoManager,
}: {
  contentLabel: string;
  docName: string;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  undoManager: Y.UndoManager;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cmEntryRef = useRef<CmCacheEntry | null>(null);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme and content label reconfigure the live view in the effects below
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = mountCmEditor({
      docName,
      container,
      sizeStats: { viewCount: 0, bytes: ytext.length },
      factory: (parent) => {
        const themeCompartment = new Compartment();
        const view = new EditorView({
          state: EditorState.create({
            doc: ytext.toString(),
            extensions: [
              codeMirrorContentAttributes(contentLabel),
              basicSetup,
              yCollab(ytext, provider.awareness, { undoManager }),
              mermaid(),
              syntaxHighlighting(propEditorHighlight),
              EditorView.lineWrapping,
              EditorView.theme({ '&': { height: '100%' } }),
              mapScrollSnapshotThroughEdits,
              themeCompartment.of(theme),
            ],
          }),
          parent,
        });
        view.scrollDOM.addEventListener(
          'scroll',
          () => {
            if (view.scrollDOM.clientHeight > 0) {
              lastScrollSnapshots.set(view, view.scrollSnapshot());
            }
          },
          { passive: true },
        );
        return {
          view,
          ydoc: provider.document,
          ytext,
          provider,
          themeCompartment,
          wordWrapCompartment: new Compartment(),
          placeholderCompartment: new Compartment(),
          lintCompartment: new Compartment(),
        };
      },
    });
    const lastScroll = lastScrollSnapshots.get(entry.view);
    if (lastScroll) entry.view.dispatch({ effects: lastScroll });
    cmEntryRef.current = entry;
    registerFullPageCmView(docName, entry.view, 'mermaidDocEditor');
    return () => {
      cmEntryRef.current = null;
      unregisterFullPageCmView(docName, entry.view);
      parkCmEditor(entry);
    };
  }, [docName, ytext, provider, undoManager]);

  useEffect(() => {
    const entry = cmEntryRef.current;
    if (entry?.hadFocus) entry.view.focus();
  }, []);

  useLayoutEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    entry.view.dispatch({ effects: entry.themeCompartment.reconfigure(theme) });
  }, [theme]);

  useLayoutEffect(() => {
    const entry = cmEntryRef.current;
    if (!entry) return;
    relabelCodeMirrorContent(entry.view, contentLabel);
  }, [contentLabel]);

  return <div ref={containerRef} className="h-full min-h-0 overflow-auto" />;
}

export const MERMAID_DIAGRAM_EDIT_ORIGIN = Symbol('mermaid-diagram-edit');

const mermaidUndoResetByManager = new WeakMap<Y.UndoManager, () => void>();

function insertedDeltaLength(insert: unknown): number {
  if (typeof insert === 'string' || Array.isArray(insert)) return insert.length;
  return 1;
}

function isUntrackedFullTextReplacement(
  event: Y.YTextEvent,
  transaction: Y.Transaction,
  undoManager: Y.UndoManager,
): boolean {
  const origin = transaction.origin;
  if (
    undoManager.trackedOrigins.has(origin) ||
    (origin != null &&
      undoManager.trackedOrigins.has((origin as { constructor?: unknown }).constructor))
  ) {
    return false;
  }

  let deleted = 0;
  let inserted = 0;
  let retained = 0;
  for (const delta of event.delta) {
    deleted += delta.delete ?? 0;
    inserted += delta.insert === undefined ? 0 : insertedDeltaLength(delta.insert);
    retained += delta.retain ?? 0;
  }
  const beforeLength = event.target.length + deleted - inserted;
  return retained === 0 && deleted === beforeLength && deleted + inserted > 0;
}

function installMermaidUndoReset(
  provider: HocuspocusProvider,
  ytext: Y.Text,
  undoManager: Y.UndoManager,
): void {
  if (mermaidUndoResetByManager.has(undoManager)) return;

  const resetStaleHistory = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (isUntrackedFullTextReplacement(event, transaction, undoManager)) undoManager.clear();
  };
  let released = false;
  const doc = ytext.doc;
  const release = (): void => {
    if (released) return;
    released = true;
    ytext.unobserve(resetStaleHistory);
    provider.off('destroy', release);
    doc?.off('destroy', release);
    if (mermaidUndoResetByManager.get(undoManager) === release) {
      mermaidUndoResetByManager.delete(undoManager);
    }
  };

  mermaidUndoResetByManager.set(undoManager, release);
  ytext.observe(resetStaleHistory);
  provider.on('destroy', release);
  doc?.on('destroy', release);
}

export function acquireMermaidUndoManager(
  provider: HocuspocusProvider,
  ytext: Y.Text,
): Y.UndoManager {
  const undoManager = acquireDocUndoManager(provider, ytext);
  undoManager.removeTrackedOrigin(null);
  undoManager.addTrackedOrigin(MERMAID_DIAGRAM_EDIT_ORIGIN);
  installMermaidUndoReset(provider, ytext, undoManager);
  return undoManager;
}

export function MermaidDocEditor({
  docName,
  provider,
  isSourceMode,
}: {
  docName: string;
  provider: HocuspocusProvider;
  isSourceMode: boolean;
}) {
  const { t } = useLingui();
  const ytext = provider.document.getText('source');

  const [source, setSource] = useState(() => ytext.toString());
  useEffect(() => {
    const sync = () => setSource(ytext.toString());
    ytext.observe(sync);
    sync();
    return () => ytext.unobserve(sync);
  }, [ytext]);

  const undoManager = acquireMermaidUndoManager(provider, ytext);

  const editBinding: MermaidSourceBinding = {
    canEdit: true,
    commitChart: (next) => replaceYText(ytext, next, MERMAID_DIAGRAM_EDIT_ORIGIN),
  };

  useEffect(() => {
    if (isSourceMode) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      if (isOverlayLayerOpen()) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      e.preventDefault();
      if (e.shiftKey) undoManager.redo();
      else undoManager.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSourceMode, undoManager]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={t`Mermaid diagram`}
      data-mermaid-doc-editor=""
      data-mermaid-doc-editor-mode={isSourceMode ? 'source' : 'diagram'}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {isSourceMode ? (
          <MermaidSourcePane
            contentLabel={t`Mermaid diagram`}
            docName={docName}
            ytext={ytext}
            provider={provider}
            undoManager={undoManager}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col p-3">
            <MermaidView chart={source} editBinding={editBinding} className="min-h-0 flex-1" />
          </div>
        )}
      </div>
    </section>
  );
}
