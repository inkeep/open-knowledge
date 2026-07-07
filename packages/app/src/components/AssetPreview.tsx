import { type InlineAssetMediaKind, toDesktopAssetHref } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
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
  // Electron renderer's page origin (Vite dev URL / file://) has no API
  // surface — the asset server lives on `window.okDesktop.config.apiOrigin`.
  // `<img>` / `<video>` / `<audio>` / `<a href>` / `<Pdf src>` use the native
  // loader, not the patched fetch in `client-fetch.ts`, so the bare `/api/asset`
  // path 404s and the browser falls back to alt text. Mirror `Image.tsx`'s
  // identical wrap (no-op on web / CLI where `window.okDesktop` is absent).
  return toDesktopAssetHref(`/api/asset?path=${encodeURIComponent(assetPath)}`);
}

// `/api/asset-text` is the sibling endpoint that the `TextViewer`
// reads from. It skips the `ASSET_EXTENSIONS` admission gate (so the
// text viewer works for `.yaml` / `.csv` / `.DS_Store` / dotfiles / any
// long-tail format) AND skips the `.gitignore` / `.okignore` filter
// (so files only visible under `showAll` mode are still readable via
// the explicit override). Path-safety (`realpath` + `isWithinContentDir`
// in `handleAssetText`) is the load-bearing check that stays. Forces
// `text/plain; charset=utf-8` and caps the response at 1 MiB.
function assetTextUrl(assetPath: string): string {
  return `/api/asset-text?path=${encodeURIComponent(assetPath)}`;
}

export function AssetPreview({ assetPath, mediaKind }: AssetPreviewProps) {
  // Local override toggle: when the user clicks "View as text" from
  // the fallback pane, mount the `TextViewer` for the
  // same asset path without re-navigating. Reset is handled at the
  // call site — `EditorArea` passes `key={activeTarget.assetPath}`, so
  // navigating to a different asset remounts this component and
  // re-initializes `forceText` to `false`. A child `key` (e.g. the
  // `key={assetPath}` on `<TextViewer>` below) does NOT reset parent
  // state — that would silently bleed `forceText=true` from a previous
  // file onto an image / video / pdf, garbling them through CodeMirror.
  const [forceText, setForceText] = useState(false);
  const src = assetUrl(assetPath);
  const fileName = assetPath.split('/').pop() ?? assetPath;
  const rawExtension = fileName.includes('.') ? (fileName.split('.').pop() ?? '') : '';
  const extension = rawExtension.length > 0 ? rawExtension.toUpperCase() : 'FILE';

  // Effective dispatch — `forceText` wins over the natural `mediaKind`
  // so the user can override an image / video / pdf / no-viewer asset
  // into the text-editor pane and back via the assetPath-keyed reset.
  const effectiveMediaKind: InlineAssetMediaKind | null = forceText ? 'text' : mediaKind;

  // PDFs render edge-to-edge via the bundled `<Pdf>` viewer — toolbar +
  // page-scroll fill the available height. `fillContainer` makes the
  // viewer size to its host (100% height) instead of the inline-block
  // default (DEFAULT_HEIGHT_PX); the standard centered padding container
  // would just shrink the usable viewport.
  if (effectiveMediaKind === 'pdf') {
    return (
      <main className="flex h-full min-h-0 flex-col bg-background" aria-label={fileName}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <Pdf src={src} title={fileName} fillContainer />
        </div>
      </main>
    );
  }

  // Text-data formats: json / toml / lock by extension (`mediaKind === 'text'`
  // from the dispatch table) or any asset the user opted into via the
  // "View as text" button below. The viewer fetches
  // the bytes itself and mounts a read-only CodeMirror — no centered
  // padding container, full height. Keyed by `assetPath` so the local
  // fetch state resets when the user navigates between assets.
  if (effectiveMediaKind === 'text') {
    return (
      <TextViewer
        key={assetPath}
        src={assetTextUrl(assetPath)}
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
            // Slot needs an explicit `h-full` so the `<img>`'s `max-h-full`
            // resolves — percentage max-heights against an auto-height
            // containing block are treated as `none` per CSS spec.
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
          // Generic fallback for assets with no built-in viewer (e.g.
          // `.zip`, `.yaml`, `.csv`, `.DS_Store`, the long tail of
          // formats we haven't bound a renderer to). Two affordances:
          // the existing "Open file" link hands off to the browser's
          // default download / external-app path, and "View as text"
          // forces the same asset through the
          // CodeMirror `TextViewer` so the author can inspect its raw
          // bytes without leaving the editor. VS Code's "Open With…"
          // parity — useful for arbitrary text-shaped files (yaml,
          // csv, ini, dotfiles) and for inspecting the leading bytes
          // of binaries when debugging.
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
