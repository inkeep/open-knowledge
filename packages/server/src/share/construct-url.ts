import type { ShareConstructUrlErrorCode, ShareFreshness } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

export const SHARE_BASE_URL = 'https://openknowledge.ai/d/';

export const SHARE_CONSTRUCT_URL_HANDLER_TAG = 'share-construct-url';

export function isValidSharePath(path: string, kind: 'doc' | 'folder'): boolean {
  if (path === '') return kind === 'folder';
  if (path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  for (const segment of path.split('/')) {
    if (segment === '..' || segment === '.git') return false;
    if (segment.length === 0) return false;
  }
  return true;
}

export function buildGitHubBlobUrl(
  host: string,
  owner: string,
  repo: string,
  branch: string,
  docPath: string,
): string {
  const encodedBranch = encodeURIComponent(branch);
  const encodedSegments = docPath.split('/').map(encodeURIComponent).join('/');
  return `https://${host}/${owner}/${repo}/blob/${encodedBranch}/${encodedSegments}`;
}

export function buildGitHubTreeUrl(
  host: string,
  owner: string,
  repo: string,
  branch: string,
  folderPath: string,
): string {
  const encodedBranch = encodeURIComponent(branch);
  const base = `https://${host}/${owner}/${repo}/tree/${encodedBranch}`;
  if (folderPath === '') return base;
  const encodedSegments = folderPath.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedSegments}`;
}

export function emitShareConstructUrlLog(
  result: 'ok' | ShareConstructUrlErrorCode,
  opts?: { branchExists?: boolean; kind?: 'doc' | 'folder'; freshness?: ShareFreshness },
): void {
  const branchExists = opts?.branchExists;
  const kind = opts?.kind;
  const freshness = opts?.freshness;
  getLogger('share').info(
    {
      action: 'construct-url',
      result,
      ...(branchExists === undefined ? {} : { branchExists }),
      ...(kind === undefined ? {} : { kind }),
      ...(freshness === undefined ? {} : { freshness }),
    },
    'share action',
  );
}
