/**
 * Shared loading / error panes for the read-only file viewers (`TextViewer`
 * source render + `SkillMarkdownLoader` rendered-markdown). Both need the same
 * centered loading spinner and error message + optional "Open file" handoff, so
 * the markup lives once here instead of being copied per viewer.
 *
 * `dataAttr` stamps an identifying attribute on every branch so consumers (DOM
 * tests, e2e selectors) can find the mounted pane regardless of async state.
 * The state is exposed as `${dataAttr}-state` ("loading" / "error") and any
 * extra attributes flow through `extraAttrs` (e.g. the source viewer's
 * `data-text-viewer-extension`).
 */
import { Trans } from '@lingui/react/macro';

interface ViewerStatusPaneBaseProps {
  fileName: string;
  /** Base data-attribute name, e.g. `data-text-viewer`. Drives the `-state` sibling. */
  dataAttr: string;
  /** Extra data-attributes stamped on every branch (e.g. the file extension). */
  extraAttrs?: Record<string, string>;
}

export function ViewerLoadingPane({ fileName, dataAttr, extraAttrs }: ViewerStatusPaneBaseProps) {
  return (
    <main
      className="flex h-full min-h-0 flex-col items-center justify-center bg-background text-muted-foreground text-sm"
      aria-label={fileName}
      {...{ [dataAttr]: '', [`${dataAttr}-state`]: 'loading' }}
      {...extraAttrs}
    >
      <span>
        <Trans>Loading {fileName}</Trans>
      </span>
    </main>
  );
}

export function ViewerErrorPane({
  fileName,
  dataAttr,
  extraAttrs,
  message,
  openHref,
}: ViewerStatusPaneBaseProps & {
  message: string;
  /** "Open file" handoff target. Only the content-dir asset path has one. */
  openHref?: string;
}) {
  return (
    <main
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background p-4 text-center"
      aria-label={fileName}
      {...{ [dataAttr]: '', [`${dataAttr}-state`]: 'error' }}
      {...extraAttrs}
    >
      <div className="font-medium text-sm">
        <Trans>Couldn't load {fileName}</Trans>
      </div>
      <div className="text-muted-foreground text-xs">{message}</div>
      {openHref ? (
        <a
          href={openHref}
          className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
        >
          <Trans>Open file</Trans>
        </a>
      ) : null}
    </main>
  );
}
