import { type InlineAssetMediaKind, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { MermaidFileViewer } from '@/components/MermaidFileViewer';
import { NotInSidebarIndicator } from '@/components/NotInSidebarIndicator';
import { TextViewer } from '@/components/TextViewer';
import { Button } from '@/components/ui/button';
import { LoadingImage } from '@/components/ui/loading-image';
import { dispatchAssetClick } from '@/editor/asset-dispatch';
import { Pdf } from '@/editor/components/Pdf';

interface AssetPreviewProps {
  assetPath: string;
  mediaKind: InlineAssetMediaKind | null;
}

function assetUrl(assetPath: string): string {
  return toDesktopAssetHref(`/api/asset?path=${encodeURIComponent(assetPath)}`);
}

function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function AssetPreview({ assetPath, mediaKind }: AssetPreviewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {}
      <NotInSidebarIndicator
        entry={{ kind: 'asset', path: assetPath }}
        className="shrink-0 border-b bg-background px-3 py-1.5"
      />
      <div className="min-h-0 flex-1">
        <AssetPreviewBody assetPath={assetPath} mediaKind={mediaKind} />
      </div>
    </div>
  );
}

function AssetPreviewBody({ assetPath, mediaKind }: AssetPreviewProps) {
  const [forceText, setForceText] = useState(false);
  const src = assetUrl(assetPath);
  const fileName = assetPath.split('/').pop() ?? assetPath;
  const rawExtension = fileName.includes('.') ? (fileName.split('.').pop() ?? '') : '';
  const extension = rawExtension.length > 0 ? rawExtension.toUpperCase() : 'FILE';

  const effectiveMediaKind: InlineAssetMediaKind | null = forceText ? 'text' : mediaKind;

  if (effectiveMediaKind === 'pdf') {
    return (
      <main className="flex h-full min-h-0 flex-col bg-background" aria-label={fileName}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Pdf src={src} title={fileName} fillContainer />
        </div>
      </main>
    );
  }

  if (effectiveMediaKind === 'text') {
    return (
      <TextViewer
        key={assetPath}
        src={assetTextUrl(assetPath)}
        assetPath={assetPath}
        fileName={fileName}
        extension={rawExtension.toLowerCase()}
      />
    );
  }

  if (effectiveMediaKind === 'mermaid') {
    return (
      <MermaidFileViewer
        key={assetPath}
        src={assetTextUrl(assetPath)}
        assetPath={assetPath}
        fileName={fileName}
        extension={rawExtension.toLowerCase()}
      />
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background" aria-label={fileName}>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {effectiveMediaKind === 'image' ? (
          <LoadingImage
            src={src}
            alt={fileName}
            draggable={false}
            targetExistence="exists"
            slotClassName="flex h-full w-full items-center justify-center"
            className="max-h-full max-w-full"
          />
        ) : effectiveMediaKind === 'video' ? (
          // biome-ignore lint/a11y/useMediaCaption: local preview files do not have sidecar captions.
          <video src={src} controls className="max-h-full max-w-full" />
        ) : effectiveMediaKind === 'audio' ? (
          // biome-ignore lint/a11y/useMediaCaption: local preview files do not have sidecar captions.
          <audio src={src} controls className="w-full max-w-md" />
        ) : (
          <div className="flex max-w-sm flex-col items-center gap-8 text-center">
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center justify-center tracking-wide text-muted-foreground/80 text-2xs font-mono">
                {extension}
              </div>
              <div className="max-w-full text-balance break-words tracking-tight font-light text-2xl">
                {fileName}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={() => setForceText(true)}
                data-testid="asset-preview-open-as-text"
                className="font-mono uppercase"
              >
                <Trans>View as text</Trans>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="font-mono uppercase"
                onClick={() => {
                  void dispatchAssetClick({
                    url: src,
                    projectRelPath: assetPath,
                    ext: rawExtension.toLowerCase(),
                    title: fileName,
                    forceOsDelegation: false,
                  });
                }}
              >
                <Trans>Open file</Trans>
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
