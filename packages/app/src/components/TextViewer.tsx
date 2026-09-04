import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { codeLanguageForExtension } from '@inkeep/open-knowledge-core';
import { basicSetup } from 'codemirror';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { okCmTheme } from '@/editor/extensions/cm-theme';
import { loadCodeMirrorLanguageForExtension } from './text-viewer-languages';
import { useViewerText, type ViewerTextSource } from './use-viewer-text';
import { ViewerErrorPane, ViewerLoadingPane } from './ViewerStatusPane';
import { resolveViewerOpenFile } from './viewer-open-file';

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

type TextViewerProps = ViewerTextSource & {
  fileName: string;
  extension: string;
};

export function TextViewer({ fileName, extension, ...source }: TextViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { resolvedTheme } = useTheme();
  const fetchState = useViewerText(source);
  const loadedContent = fetchState.status === 'loaded' ? fetchState.content : null;

  useEffect(() => {
    if (!containerRef.current) return;
    if (loadedContent === null) return;

    const normalized = extension.toLowerCase();
    const canonical = codeLanguageForExtension(normalized);
    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    let aborted = false;
    let view: EditorView | null = null;
    void loadCodeMirrorLanguageForExtension(normalized, canonical).then((language) => {
      if (aborted) return;
      if (!containerRef.current) return;
      const extensions = [
        basicSetup,
        ...(language ? [language] : []),
        EditorView.editable.of(true),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        theme,
      ];
      view = new EditorView({
        state: EditorState.create({ doc: loadedContent, extensions }),
        parent: containerRef.current,
      });
      viewRef.current = view;
    });

    return () => {
      aborted = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [loadedContent, extension, resolvedTheme]);

  const extraAttrs = { 'data-text-viewer-extension': extension };
  if (fetchState.status === 'loading') {
    return (
      <ViewerLoadingPane fileName={fileName} dataAttr="data-text-viewer" extraAttrs={extraAttrs} />
    );
  }

  if (fetchState.status === 'error') {
    return (
      <ViewerErrorPane
        fileName={fileName}
        dataAttr="data-text-viewer"
        extraAttrs={extraAttrs}
        message={fetchState.message}
        openFile={resolveViewerOpenFile({
          assetPath: source.assetPath,
          fileName,
          extension,
          httpStatus: fetchState.httpStatus,
        })}
      />
    );
  }

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={fileName}
      data-text-viewer=""
      data-text-viewer-state="loaded"
      data-text-viewer-extension={extension}
    >
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto" />
    </main>
  );
}
