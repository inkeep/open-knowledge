import { CaptureUpdateAction, Excalidraw, restore, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useLingui } from '@lingui/react/macro';
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { replaceYText } from './MermaidDocEditor';

import '@/lib/excalidraw-env';

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0];
type RestoreResult = {
  elements: ReturnType<typeof restore>['elements'];
  appState: ReturnType<typeof restore>['appState'];
  files: ReturnType<typeof restore>['files'];
};

type ParseOutcome = { ok: true; scene: RestoreResult } | { ok: false; scene: RestoreResult };

function parseSnapshot(str: string): ParseOutcome {
  if (str.trim() === '') return { ok: true, scene: restore(null, null, null) };
  try {
    const parsed: unknown = JSON.parse(str);
    return { ok: true, scene: restore(parsed as Parameters<typeof restore>[0], null, null) };
  } catch {
    return { ok: false, scene: restore(null, null, null) };
  }
}

export function ExcalidrawDocEditor({ provider }: { provider: HocuspocusProvider }) {
  const { t } = useLingui();
  const ytext = provider.document.getText('source');
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  const lastSavedRef = useRef<string>(ytext.toString());

  const initialOutcome = parseSnapshot(ytext.toString());
  if (!initialOutcome.ok) {
    console.warn(
      "[ExcalidrawDocEditor] initial snapshot could not be parsed — falling back to a blank canvas; the original bytes remain in the doc until the user draws their first element (appState-only tweaks on an empty canvas don't unblock the guard)",
    );
  }

  const blockBlankOverwriteRef = useRef<boolean>(!initialOutcome.ok);

  useEffect(() => {
    if (excalidrawAPI === null) return;
    const sync = () => {
      const str = ytext.toString();
      if (str === lastSavedRef.current) return;
      lastSavedRef.current = str;
      const outcome = parseSnapshot(str);
      if (!outcome.ok) {
        console.warn(
          '[ExcalidrawDocEditor] sync: remote snapshot could not be parsed — skipping this update',
        );
        return;
      }
      const { elements, appState, files } = outcome.scene;
      excalidrawAPI.updateScene({
        elements,
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      const fileValues = Object.values(files);
      if (fileValues.length > 0) excalidrawAPI.addFiles(fileValues);
    };
    ytext.observe(sync);
    return () => ytext.unobserve(sync);
  }, [ytext, excalidrawAPI]);

  const handleChange: NonNullable<ExcalidrawProps['onChange']> = (elements, appState, files) => {
    if (blockBlankOverwriteRef.current) {
      if (elements.length === 0) return;
      blockBlankOverwriteRef.current = false;
    }
    const str = serializeAsJSON(elements, appState, files, 'local');
    if (str === lastSavedRef.current) return;
    lastSavedRef.current = str;
    replaceYText(ytext, str);
  };

  return (
    <main
      className="relative flex h-full min-h-0 flex-col bg-background"
      aria-label={t`Excalidraw canvas`}
      data-excalidraw-doc-editor=""
    >
      <div className="absolute inset-0 z-0">
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          initialData={initialOutcome.scene}
          onChange={handleChange}
        />
      </div>
    </main>
  );
}
