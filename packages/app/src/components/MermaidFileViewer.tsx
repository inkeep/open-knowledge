/**
 * Read-only viewer for a standalone Mermaid diagram file
 * (`.mmd` / `.mermaid`). Fetches the raw text via the ungated
 * `/api/asset-text` endpoint — same fetch path as `TextViewer` — and hands
 * the source to the editor's `<Mermaid>` component. Because Mermaid is
 * the single-source-of-truth renderer here (identical theming + parse-
 * error advisory as ` ```mermaid ` fences inside docs), keeping the file
 * viewer as a thin wrapper avoids a parallel diagram-render surface.
 *
 * The segmented Diagram ⇄ Source toggle mirrors `EditorModeToggle` (same
 * `ToggleGroup` primitives, sizing, and top-of-pane placement) so the
 * file viewer reads as "the same control we use for md docs" rather
 * than a bespoke pane. MermaidView's own error state renders the
 * offending source below its advisory; we hide that copy inside this
 * wrapper so parse failures show exactly one path to the raw bytes —
 * the Source toggle.
 *
 * STOP: do not bind this viewer to a Y.Doc. `.mmd`/`.mermaid` are NOT in
 * `SUPPORTED_DOC_EXTENSIONS` — the file is read-only by contract. Editing
 * .mmd in place is a separate slice.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { Code, Workflow } from 'lucide-react';
import { useState } from 'react';
import { TextViewer } from '@/components/TextViewer';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MermaidView } from '@/editor/components/Mermaid';
import { useViewerText, type ViewerTextSource } from './use-viewer-text';
import { ViewerErrorPane, ViewerLoadingPane } from './ViewerStatusPane';
import { resolveViewerOpenFile } from './viewer-open-file';

type MermaidFileViewerProps = ViewerTextSource & {
  fileName: string;
  /** Lowercased, dot-stripped (e.g. `mmd`, not `.MMD`). */
  extension: string;
};

type Mode = 'diagram' | 'source';

export function MermaidFileViewer({ fileName, extension, ...source }: MermaidFileViewerProps) {
  const { t } = useLingui();
  const [mode, setMode] = useState<Mode>('diagram');
  const fetchState = useViewerText(source);

  const extraAttrs = { 'data-mermaid-file-viewer-extension': extension };

  if (fetchState.status === 'loading') {
    return (
      <ViewerLoadingPane
        fileName={fileName}
        dataAttr="data-mermaid-file-viewer"
        extraAttrs={extraAttrs}
      />
    );
  }

  if (fetchState.status === 'error') {
    return (
      <ViewerErrorPane
        fileName={fileName}
        dataAttr="data-mermaid-file-viewer"
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

  const text = fetchState.content;

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={fileName}
      data-mermaid-file-viewer=""
      data-mermaid-file-viewer-state="loaded"
      data-mermaid-file-viewer-mode={mode}
      {...extraAttrs}
    >
      <div className="flex shrink-0 items-center justify-center border-b bg-background py-2">
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v: Mode | '') => {
            if (v) setMode(v);
          }}
          aria-label={t`Diagram view mode`}
          variant="segmented"
          size="sm"
          spacing={1}
          className="shrink-0 bg-muted p-0.5 data-[size=sm]:rounded-[10px]"
        >
          <Tooltip>
            <ToggleGroupItem
              value="diagram"
              aria-label={t`Show diagram`}
              className="size-7 px-0 dark:data-[state=on]:bg-foreground/15"
              asChild
            >
              <TooltipTrigger>
                <Workflow className="size-4" />
              </TooltipTrigger>
            </ToggleGroupItem>
            <TooltipContent side="bottom">
              <Trans>Diagram</Trans>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <ToggleGroupItem
              value="source"
              aria-label={t`Show source`}
              className="size-7 px-0 dark:data-[state=on]:bg-foreground/15"
              asChild
            >
              <TooltipTrigger>
                <Code className="size-4" />
              </TooltipTrigger>
            </ToggleGroupItem>
            <TooltipContent side="bottom">
              <Trans>Source</Trans>
            </TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'diagram' ? (
          // `[&_.mermaid-error-source]:hidden` suppresses MermaidView's
          // in-error raw-source `<pre>` — the Source toggle already carries
          // that responsibility, and rendering the file twice on parse
          // failure (advisory + inline source pane below) reads as
          // duplication rather than diagnosis.
          <div className="flex h-full min-h-0 flex-col p-3 [&_.mermaid-error-source]:hidden">
            <MermaidView chart={text} className="min-h-0 flex-1" />
          </div>
        ) : (
          // Source-mode fallback and copy-the-raw-bytes affordance. Reusing
          // `TextViewer` (rather than a bare `<pre>`) so theme, line
          // numbering, Cmd-A, and read-only semantics match every other
          // source view in the app. The extension stays `mmd` even for
          // `.mermaid` files — CodeMirror has no Mermaid grammar so it
          // falls through to plain-text anyway; the label just needs to
          // read consistently.
          <TextViewer {...source} fileName={fileName} extension={extension} />
        )}
      </div>
    </main>
  );
}
