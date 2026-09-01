import { ASSET_EXTENSIONS, toDesktopAssetHref } from '@inkeep/open-knowledge-core';

export interface ViewerOpenFileTarget {
  readonly projectRelPath: string;
  readonly ext: string;
  readonly title: string;
  readonly url: string;
}

interface ResolveViewerOpenFileArgs {
  readonly assetPath: string | undefined;
  readonly fileName: string;
  readonly extension: string;
  readonly httpStatus: number | undefined;
}

export function resolveViewerOpenFile({
  assetPath,
  fileName,
  extension,
  httpStatus,
}: ResolveViewerOpenFileArgs): ViewerOpenFileTarget | undefined {
  if (!assetPath) return undefined;
  if (httpStatus === 404) return undefined;
  const ext = extension.toLowerCase();
  const endpoint = ASSET_EXTENSIONS.has(ext) ? '/api/asset' : '/api/asset-text';
  return {
    projectRelPath: assetPath,
    ext,
    title: fileName,
    url: toDesktopAssetHref(`${endpoint}?path=${encodeURIComponent(assetPath)}`),
  };
}
