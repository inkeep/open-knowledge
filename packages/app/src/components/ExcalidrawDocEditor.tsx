/**
 * Editor for a standalone Excalidraw canvas doc (`.excalidraw`, `.canvas`, `.okdraw`).
 * Syncs the canvas state (elements, appState, files) to the underlying `Y.Text('source')` CRDT as a JSON snapshot.
 */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { Excalidraw } from '@excalidraw/excalidraw';
import { useTheme } from 'next-themes';
import type { ComponentProps } from 'react';
import { useEffect, useRef, useState } from 'react';
import { replaceYText } from './MermaidDocEditor';

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0];
type ExcalidrawInitialDataState = NonNullable<ExcalidrawProps['initialData']>;

export function ExcalidrawDocEditor({
  provider,
}: {
  docName: string;
  provider: HocuspocusProvider;
}) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const ytext = provider.document.getText('source');
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  // Parse initial state snapshot from Y.Text
  const [initialData] = useState<ExcalidrawInitialDataState>(() => {
    const str = ytext.toString();
    if (str && str.trim() !== '') {
      try {
        const parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object') {
          return {
            elements: Array.isArray(parsed.elements) ? parsed.elements : [],
            appState: parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : {},
            files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
          };
        }
      } catch (e) {
        console.error('Failed to load Excalidraw snapshot from Y.Text', e);
      }
    }
    return { elements: [], appState: {}, files: {} };
  });

  const lastSavedRef = useRef<string>(ytext.toString());

  // Listen to remote Y.Text updates and push into Excalidraw scene
  useEffect(() => {
    const sync = () => {
      const str = ytext.toString();
      if (str === lastSavedRef.current) return;
      lastSavedRef.current = str;
      if (!excalidrawAPI) return;
      if (str && str.trim() !== '') {
        try {
          const parsed = JSON.parse(str);
          if (parsed && typeof parsed === 'object') {
            excalidrawAPI.updateScene({
              elements: Array.isArray(parsed.elements) ? parsed.elements : [],
              appState: parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : undefined,
            });
          }
        } catch (e) {
          console.error('Failed to parse remote Excalidraw update', e);
        }
      }
    };

    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext, excalidrawAPI]);

  // Save changes to Y.Text when user edits in Excalidraw
  const handleChange = (
    elements: readonly any[],
    appState: any,
    files: any,
  ) => {
    if (!excalidrawAPI) return;
    // Extract non-transient appState fields
    const minimalAppState = {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      theme: appState.theme,
    };
    const snapshot = {
      elements,
      appState: minimalAppState,
      files,
    };
    const str = JSON.stringify(snapshot);
    if (str !== lastSavedRef.current) {
      lastSavedRef.current = str;
      replaceYText(ytext, str);
    }
  };

  const themeMode = resolvedTheme === 'dark' ? 'dark' : 'light';

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background relative"
      aria-label={t`Excalidraw canvas`}
      data-excalidraw-doc-editor=""
    >
      <div className="absolute inset-0 z-0">
        <Excalidraw
          excalidrawAPI={(api) => setExcalidrawAPI(api)}
          initialData={initialData}
          onChange={handleChange}
          theme={themeMode}
        />
      </div>
    </main>
  );
}
