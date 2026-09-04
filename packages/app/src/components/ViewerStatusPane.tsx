import { Trans } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import { dispatchAssetClick } from '@/editor/asset-dispatch';
import type { ViewerOpenFileTarget } from './viewer-open-file';

interface ViewerStatusPaneBaseProps {
  fileName: string;
  dataAttr: string;
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
