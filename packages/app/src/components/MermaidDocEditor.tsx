/**
 * Mounted by `EditorActivityPool` inside the doc's `DocumentBoundary` (peer to the conflict
 * `DiffViewBoundary` branch), so `provider` is sync-gated and the precedent #18(b) hybrid render
 * tree is preserved.
 */

import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { basicSetup } from 'codemirror';
import { mermaid } from 'codemirror-lang-mermaid';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import type * as Y from 'yjs';
import { propEditorHighlight } from '@/editor/components/CodeMirrorPropInput';
import { type MermaidSourceBinding, MermaidView } from '@/editor/components/Mermaid';
import { okCmTheme } from '@/editor/extensions/cm-theme';
import { registerFullPageCmView, unregisterFullPageCmView } from '@/editor/full-page-cm-views';
import { sharedUndoManagerFor } from '@/editor/shared-undo-manager';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';

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
  docName,
  ytext,
  provider,
  undoManager,
}: {
  docName: string;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  undoManager: Y.UndoManager;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          yCollab(ytext, provider.awareness, { undoManager }),
          mermaid(),
          syntaxHighlighting(propEditorHighlight),
          EditorView.lineWrapping,
          EditorView.theme({ '&': { height: '100%' } }),
          theme,
        ],
      }),
      parent: el,
    });
    registerFullPageCmView(docName, view, 'mermaidDocEditor');
    return () => {
      unregisterFullPageCmView(docName, view);
      view.destroy();
    };
  }, [docName, ytext, provider, resolvedTheme, undoManager]);

  return <div ref={containerRef} className="h-full min-h-0 overflow-auto" />;
}

export const MERMAID_DIAGRAM_EDIT_ORIGIN = Symbol('mermaid-diagram-edit');

export function acquireMermaidUndoManager(
  provider: HocuspocusProvider,
  ytext: Y.Text,
): Y.UndoManager {
  const undoManager = sharedUndoManagerFor(ytext, provider);
  undoManager.removeTrackedOrigin(null);
  undoManager.addTrackedOrigin(MERMAID_DIAGRAM_EDIT_ORIGIN);
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
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={t`Mermaid diagram`}
      data-mermaid-doc-editor=""
      data-mermaid-doc-editor-mode={isSourceMode ? 'source' : 'diagram'}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {isSourceMode ? (
          <MermaidSourcePane
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
    </main>
  );
}
