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
import { Button } from '@/components/ui/button';
import { dispatchAssetClick } from '@/editor/asset-dispatch';
import type { ViewerOpenFileTarget } from './viewer-open-file';

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
  openFile,
}: ViewerStatusPaneBaseProps & {
  message: string;
  /**
   * OS-handoff target for the "Open file" affordance, or `undefined` to render
   * no affordance at all. Resolved by `resolveViewerOpenFile` — see there for
   * why this is a dispatch context and not an href.
   */
  openFile?: ViewerOpenFileTarget;
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
      {openFile ? (
        // Deliberately not an `<a href>`: a same-frame navigation here unloads
        // the whole single-page app and strands the user on a raw API response
        // with no way back. The dispatcher hands the file to the OS on desktop
        // and opens a new tab on web, either way leaving the app mounted.
        // `forceOsDelegation` skips the in-app viewer registry — an in-app
        // viewer is precisely what just failed on this file.
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          data-testid="viewer-open-file"
          onClick={() => {
            void dispatchAssetClick({
              url: openFile.url,
              projectRelPath: openFile.projectRelPath,
              ext: openFile.ext,
              title: openFile.title,
              forceOsDelegation: true,
            });
          }}
        >
          <Trans>Open file</Trans>
        </Button>
      ) : null}
    </main>
  );
}
