/**
 * Editor for a standalone Mermaid doc (`.mmd` / `.mermaid`). These are real
 * Y.Text('source')-only CRDT docs (the markdown bridge is gated off server-side
 * — see `isMermaidDoc`), so both panes bind to the same `Y.Text` and stay in
 * sync live:
 *
 *  - Diagram (wysiwyg) mode → the editor's `<MermaidView>` with an `editBinding`
 *    that splices click-to-edit label changes back into `Y.Text` — exact parity
 *    with codefenced ` ```mermaid ` editing.
 *  - Source mode → an editable CodeMirror bound to the same `Y.Text` via
 *    `yCollab`, with real Mermaid syntax highlighting (`codemirror-lang-mermaid`,
 *    already in the editor bundle) on the shared `propEditorHighlight` style.
 *
 * Driven by the global `isSourceMode` (the toolbar's wysiwyg/source toggle):
 * for a diagram doc, "wysiwyg" == the rendered, editable diagram — consistent
 * with the app's rendered-vs-raw mental model, so no bespoke toggle is needed.
 *
 * Mounted by `EditorActivityPool` inside the doc's `DocumentBoundary` (peer to
 * the conflict `DiffViewBoundary` branch), so `provider` is sync-gated and the
 * precedent #18(b) hybrid render tree is preserved.
 */

import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { basicDarkInit, basicLightInit } from '@uiw/codemirror-theme-basic';
import { basicSetup } from 'codemirror';
import { mermaid } from 'codemirror-lang-mermaid';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { propEditorHighlight } from '@/editor/components/CodeMirrorPropInput';
import { type MermaidSourceBinding, MermaidView } from '@/editor/components/Mermaid';

const darkTheme = basicDarkInit({
  settings: { background: 'var(--background)', gutterBackground: 'var(--muted)' },
});
const lightTheme = basicLightInit({
  settings: { background: 'var(--background)', gutterBackground: 'var(--muted)' },
});

/**
 * Replace `Y.Text` content with `next` using the smallest edit that spans the
 * change — keep the common prefix/suffix so `yCollab` peers, cursors, and the
 * undo manager see a targeted splice rather than a whole-document churn.
 */
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

/**
 * Editable CodeMirror bound to the Mermaid doc's `Y.Text('source')`. The
 * shared `undoManager` is passed to `yCollab` so source-pane typing and
 * diagram-mode label edits share a single undo stack — Ctrl/Cmd+Z in
 * either mode walks through the merged history.
 */
function MermaidSourcePane({
  ytext,
  provider,
  undoManager,
}: {
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
    return () => view.destroy();
    // Rebuild only on doc identity / theme change — yCollab keeps content synced.
  }, [ytext, provider, resolvedTheme, undoManager]);

  return <div ref={containerRef} className="h-full min-h-0 overflow-auto" />;
}

/**
 * Stable transaction origin for diagram-mode label commits. Y.UndoManager
 * only tracks edits whose origin is in `trackedOrigins`; the shared
 * manager below adds this symbol so click-to-edit rewrites become undo
 * steps like any other. Undefined origins would drop off the stack.
 */
const MERMAID_DIAGRAM_EDIT_ORIGIN = Symbol('mermaid-diagram-edit');

export function MermaidDocEditor({
  provider,
  isSourceMode,
}: {
  docName: string;
  provider: HocuspocusProvider;
  isSourceMode: boolean;
}) {
  const { t } = useLingui();
  const ytext = provider.document.getText('source');

  // Live source for the diagram — a label edit committed through the binding (or
  // a source-pane keystroke) mutates `Y.Text`, and this observer re-renders the
  // diagram from the new bytes.
  const [source, setSource] = useState(() => ytext.toString());
  useEffect(() => {
    const sync = () => setSource(ytext.toString());
    ytext.observe(sync);
    sync();
    return () => ytext.unobserve(sync);
  }, [ytext]);

  // Shared UndoManager on the Y.Text — tracks both diagram-mode commits
  // (via MERMAID_DIAGRAM_EDIT_ORIGIN) and source-pane typing (yCollab
  // adds its own sync-conf origin internally via `addTrackedOrigin`).
  // Ctrl/Cmd+Z in either mode walks through the merged stack.
  // The Y.UndoManager listens on the Y.Doc via `afterTransactionHandler`.
  // Don't call `.destroy()` in a StrictMode/HMR cleanup cycle — the same
  // useState instance is re-used on the second effect run, and destroying
  // it silently unhooks the handler so subsequent commits are dropped
  // (visible as an empty undo stack after every edit). The UM is torn
  // down naturally when the Y.Doc is disposed on unmount.
  const [undoManager] = useState(
    () => new Y.UndoManager(ytext, { trackedOrigins: new Set([MERMAID_DIAGRAM_EDIT_ORIGIN]) }),
  );

  const editBinding: MermaidSourceBinding = {
    canEdit: true,
    getChart: () => ytext.toString(),
    commitChart: (next) => replaceYText(ytext, next, MERMAID_DIAGRAM_EDIT_ORIGIN),
  };

  // Diagram-mode keyboard shortcut — Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z drive
  // the shared UndoManager. Wired at the window level (rather than on
  // the wrapper div) so the shortcut fires without needing focus on the
  // diagram surface itself — SVG has no natural focus target the user
  // clicks into. Source mode's keybinding is owned by yCollab's own
  // y-undomanager keymap (already active while the CodeMirror view has
  // focus, so it wins over this listener when the source pane is open).
  useEffect(() => {
    if (isSourceMode) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      // If the user is typing in an input overlay (label editor) or any
      // contenteditable, let the platform undo handle that input instead.
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
          <MermaidSourcePane ytext={ytext} provider={provider} undoManager={undoManager} />
        ) : (
          <div className="flex h-full min-h-0 flex-col p-3">
            <MermaidView chart={source} editBinding={editBinding} className="min-h-0 flex-1" />
          </div>
        )}
      </div>
    </main>
  );
}
