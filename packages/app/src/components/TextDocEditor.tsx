/**
 * Editor for an editable text doc (`.ts` / `.json` / `.css` / `.txt` / … —
 * see `EDITABLE_TEXT_FILE_EXTENSIONS`). These are verbatim
 * Y.Text('source')-only CRDT docs, the same doc class as standalone Mermaid
 * docs (markdown bridge gated off server-side; bytes stored verbatim), so a
 * plain-text file edits like a normal IDE buffer: CodeMirror bound to the
 * shared `Y.Text` via `yCollab`, collaborative cursors included.
 *
 * Language highlighting resolves lazily from the file extension through the
 * same `text-viewer-languages` loader the read-only asset `TextViewer` uses —
 * grammars stay out of the main bundle and unknown extensions fall back to
 * plain text.
 *
 * There is no wysiwyg mode for a code file, so the editor renders the same
 * CodeMirror surface regardless of the global source-mode toggle (mirrors how
 * a diagram doc treats "wysiwyg" as its rendered form; here source IS the
 * only form).
 *
 * Mounted by `EditorActivityPool` inside the doc's `DocumentBoundary` (peer
 * to the MermaidDocEditor branch), so `provider` is sync-gated and the
 * precedent #18(b) hybrid render tree is preserved.
 */

import { type Language, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  codeLanguageForExtension,
  EDITABLE_TEXT_EXTRA_LANGUAGE,
  extensionOf,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { basicSetup } from 'codemirror';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { propEditorHighlight } from '@/editor/components/CodeMirrorPropInput';
import { okCmTheme } from '@/editor/extensions/cm-theme';
import { loadCodeMirrorLanguageForExtension } from './text-viewer-languages';

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

export function TextDocEditor({
  docName,
  provider,
}: {
  docName: string;
  provider: HocuspocusProvider;
}) {
  const { t } = useLingui();
  const basename = docName.slice(docName.lastIndexOf('/') + 1);
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const ytext = provider.document.getText('source');
  // Stable across theme-driven view rebuilds so undo history survives them
  // (yCollab would otherwise mint a fresh UndoManager per rebuild). Not
  // destroyed in cleanup — same StrictMode rationale as MermaidDocEditor.
  const [undoManager] = useState(() => new Y.UndoManager(ytext));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    // Language pack loads async; a Compartment lets it slot in without
    // rebuilding the view (which would drop cursor/scroll state).
    const languageSlot = new Compartment();
    const wrapSlot = new Compartment();
    const hasGrammar =
      (EDITABLE_TEXT_EXTRA_LANGUAGE[extensionOf(docName)] ??
        codeLanguageForExtension(extensionOf(docName))) !== null && extensionOf(docName) !== '';
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          yCollab(ytext, provider.awareness, { undoManager }),
          languageSlot.of([]),
          syntaxHighlighting(propEditorHighlight),
          // Plain-text formats (txt / log / csv — no grammar) read better
          // wrapped; code keeps horizontal scroll like an IDE.
          wrapSlot.of(hasGrammar ? [] : EditorView.lineWrapping),
          EditorView.theme({ '&': { height: '100%' } }),
          theme,
        ],
      }),
      parent: el,
    });
    let disposed = false;
    const extension = extensionOf(docName) || null;
    if (extension) {
      void loadCodeMirrorLanguageForExtension(
        extension,
        EDITABLE_TEXT_EXTRA_LANGUAGE[extension] ?? codeLanguageForExtension(extension),
      ).then((language: Language | null) => {
        if (disposed || !language) return;
        view.dispatch({ effects: languageSlot.reconfigure(language) });
      });
    }
    return () => {
      disposed = true;
      view.destroy();
    };
    // Rebuild only on doc identity / theme change — yCollab keeps content synced.
  }, [ytext, provider, resolvedTheme, docName, undoManager]);

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={t`${basename} — text editor`}
      data-text-doc-editor=""
    >
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" />
    </main>
  );
}
