import { classifyMarkdownHref, resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import { isLinkValidationVisible } from '../link-validation-policy';
import type { PageListCacheSnapshot } from '../page-list-cache';
import type { MarkInfo } from './mark-identity';

type LinkResolutionState =
  | 'loading'
  | 'external'
  | 'anchor'
  | 'resolved'
  | 'folder'
  | 'unresolved'
  | 'asset';

function setHasPathCaseInsensitive(paths: ReadonlySet<string>, target: string): boolean {
  if (paths.has(target)) return true;
  const lowerTarget = target.toLowerCase();
  for (const path of paths) {
    if (path.toLowerCase() === lowerTarget) return true;
  }
  return false;
}

export function isResolvedAssetHref(
  href: string,
  sourceDocName: string,
  assetPaths: ReadonlySet<string> | undefined,
  filePaths: ReadonlySet<string> | undefined,
  options: { literal: boolean },
): boolean {
  const projectRelPath = resolveAssetProjectPath(href, sourceDocName, {
    literal: options.literal,
  });
  if (projectRelPath === null) return false;
  if (assetPaths && setHasPathCaseInsensitive(assetPaths, projectRelPath)) return true;
  if (filePaths && setHasPathCaseInsensitive(filePaths, projectRelPath)) return true;
  return false;
}

export function computeLinkResolutionState(
  href: string,
  sourceDocName: string,
  cache: PageListCacheSnapshot | null,
): LinkResolutionState {
  const target = classifyMarkdownHref(href, sourceDocName);
  if (!target) return 'unresolved';
  if (target.kind === 'external') return 'external';
  if (target.kind === 'anchor') return 'anchor';

  if (cache === null) return 'loading';

  if (target.kind === 'asset') {
    if (cache.assetPaths === undefined && cache.filePaths === undefined) return 'asset';
    return isResolvedAssetHref(target.url, sourceDocName, cache.assetPaths, cache.filePaths, {
      literal: target.literal,
    })
      ? 'asset'
      : 'unresolved';
  }

  const intent = resolveLinkTargetIntent(target.docName, {
    pages: cache.pages,
    folderPaths: cache.folderPaths,
  });
  if (intent.kind !== 'create') return intent.displayState;

  if (
    isResolvedAssetHref(href, sourceDocName, cache.assetPaths, cache.filePaths, { literal: false })
  ) {
    return 'asset';
  }
  return 'unresolved';
}

export function computeLinkResolutionAttrs(
  markInfo: MarkInfo,
  cache: PageListCacheSnapshot | null,
  sourceDocName: string,
): Record<string, string> | null {
  const href = markInfo.attrs?.href;
  if (typeof href !== 'string' || href.length === 0) return null;
  const state = computeLinkResolutionState(href, sourceDocName, cache);
  if (state === 'unresolved' && !isLinkValidationVisible()) return null;
  return { 'data-resolution-state': state };
}

export function makeLinkResolutionAttrsComputer(
  sourceDocName: string,
): (markInfo: MarkInfo, cache: PageListCacheSnapshot | null) => Record<string, string> | null {
  return (markInfo, cache) => computeLinkResolutionAttrs(markInfo, cache, sourceDocName);
}
