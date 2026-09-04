import { resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { useOptionalPageList } from '../../components/PageListContext';
import { isResolvedAssetHref } from '../extensions/link-resolution';

export type ImageTargetExistence = 'exists' | 'missing' | 'unknown';

export function classifyImageTargetExistence(
  src: string,
  sourceDocName: string,
  assetPaths: ReadonlySet<string> | undefined,
  filePaths: ReadonlySet<string> | undefined,
): ImageTargetExistence {
  const projectRelPath = resolveAssetProjectPath(src, sourceDocName, { literal: false });
  if (projectRelPath === null) return 'unknown';
  return isResolvedAssetHref(src, sourceDocName, assetPaths, filePaths, { literal: false })
    ? 'exists'
    : 'missing';
}

export function useImageTargetExistence(src: string | undefined): ImageTargetExistence {
  const pageList = useOptionalPageList();
  if (src === undefined || src === '') return 'missing';
  if (pageList === null) return 'unknown';
  if (pageList.loading) return 'unknown';
  return classifyImageTargetExistence(src, '', pageList.assetPaths, pageList.filePaths);
}
