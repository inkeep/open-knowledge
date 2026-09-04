import {
  type AssetLinkTarget,
  classifyWikiLinkTarget,
  type DocLinkTarget,
  type ExternalLinkTarget,
} from './link-targets.ts';
import { toWikiLinkSlug } from './slug.ts';

export interface WikiLinkLookupIndex {
  readonly pages: ReadonlySet<string>;
  readonly pagesBySlug: ReadonlyMap<string, string>;
  readonly pagesByBasename?: ReadonlyMap<string, string>;
  readonly assetPaths?: ReadonlySet<string>;
  readonly filePaths?: ReadonlySet<string>;
}

export type WikiLinkPagesInput = ReadonlySet<string> | WikiLinkLookupIndex;

function isLookupIndex(input: WikiLinkPagesInput): input is WikiLinkLookupIndex {
  return 'pagesBySlug' in input;
}

function getPagesSet(input: WikiLinkPagesInput): ReadonlySet<string> {
  return isLookupIndex(input) ? input.pages : input;
}

function getAssetPathsSet(input: WikiLinkPagesInput, assetPaths?: ReadonlySet<string>) {
  return isLookupIndex(input) ? (input.assetPaths ?? new Set<string>()) : (assetPaths ?? new Set());
}

function getFilePathsSet(input: WikiLinkPagesInput, filePaths?: ReadonlySet<string>) {
  return isLookupIndex(input) ? (input.filePaths ?? new Set<string>()) : (filePaths ?? new Set());
}

function compareDocNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function buildPagesBySlugIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const page of pages) {
    const key = slugFn(page);
    if (key && !index.has(key)) index.set(key, page);
  }
  return index;
}

export function buildPagesByBasenameIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const sorted = [...pages].sort(compareDocNames);
  for (const page of sorted) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    const key = slugFn(basename);
    if (key && !index.has(key)) index.set(key, page);
  }
  return index;
}

function slugLookup(target: string, input: WikiLinkPagesInput): string | undefined {
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isLookupIndex(input)) {
    return input.pagesBySlug.get(targetSlug);
  }
  for (const page of input) {
    if (toWikiLinkSlug(page) === targetSlug) return page;
  }
  return undefined;
}

function basenameLookup(target: string, input: WikiLinkPagesInput): string | undefined {
  if (target.includes('/')) return undefined;
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isLookupIndex(input)) {
    return input.pagesByBasename?.get(targetSlug);
  }
  let bestMatch: string | undefined;
  for (const page of input) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    if (toWikiLinkSlug(basename) !== targetSlug) continue;
    if (bestMatch === undefined || compareDocNames(page, bestMatch) < 0) bestMatch = page;
  }
  return bestMatch;
}

export function getWikiLinkResolutionCandidates(target: string): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];
  const slug = toWikiLinkSlug(trimmed);
  return slug.length > 0 && slug !== trimmed ? [slug] : [];
}

export function resolveWikiLinkTargetDocName(
  target: string,
  input: WikiLinkPagesInput,
): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  const pages = getPagesSet(input);
  if (pages.has(trimmed)) return trimmed;
  const viaSlug = slugLookup(trimmed, input);
  if (viaSlug) return viaSlug;
  for (const candidate of getWikiLinkResolutionCandidates(trimmed)) {
    if (pages.has(candidate)) return candidate;
  }
  const folderIndexDocName = resolveFolderIndexDocName(trimmed, pages);
  if (folderIndexDocName) return folderIndexDocName;
  return basenameLookup(trimmed, input);
}

function resolveFolderIndexDocName(target: string, pages: ReadonlySet<string>): string | undefined {
  const canonical = `${target}/index`;
  if (pages.has(canonical)) return canonical;
  const slashIndex = target.lastIndexOf('/');
  const leaf = slashIndex === -1 ? target : target.slice(slashIndex + 1);
  const legacy = leaf ? `${target}/${leaf}` : null;
  if (legacy && pages.has(legacy)) return legacy;
  return undefined;
}

function normalizeAssetTarget(target: string): string {
  const trimmed = target.trim();
  const withoutHash = (trimmed.split('#')[0] ?? '').trim();
  const withoutQuery = (withoutHash.split('?')[0] ?? '').trim();
  return withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
}

export function resolveWikiLinkAssetTarget(
  target: string,
  assetPaths: ReadonlySet<string>,
  filePaths?: ReadonlySet<string>,
): string | null {
  const normalized = normalizeAssetTarget(target);
  if (!normalized) return null;

  const lowerTarget = normalized.toLowerCase();
  const partitions: ReadonlyArray<ReadonlySet<string>> = filePaths
    ? [assetPaths, filePaths]
    : [assetPaths];

  for (const partition of partitions) {
    if (partition.has(normalized)) return normalized;
    for (const path of partition) {
      if (path.toLowerCase() === lowerTarget) return path;
    }
  }

  if (normalized.includes('/')) return null;
  const matches: string[] = [];
  for (const partition of partitions) {
    for (const path of partition) {
      const slash = path.lastIndexOf('/');
      const basename = slash === -1 ? path : path.slice(slash + 1);
      if (basename.toLowerCase() === lowerTarget) matches.push(path);
    }
  }
  if (matches.length === 0) return null;
  return matches.sort(compareDocNames)[0] ?? null;
}

export function isResolvedWikiLinkTarget(
  target: string,
  pages: WikiLinkPagesInput,
  assetPaths?: ReadonlySet<string>,
  filePaths?: ReadonlySet<string>,
): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (
    resolveWikiLinkAssetTarget(
      trimmed,
      getAssetPathsSet(pages, assetPaths),
      getFilePathsSet(pages, filePaths),
    )
  ) {
    return true;
  }

  const pagesSet = getPagesSet(pages);
  if (pagesSet.has(trimmed)) return true;

  if (getWikiLinkResolutionCandidates(trimmed).some((candidate) => pagesSet.has(candidate))) {
    return true;
  }

  if (slugLookup(trimmed, pages) !== undefined) return true;

  if (resolveFolderIndexDocName(trimmed, pagesSet)) return true;

  return basenameLookup(trimmed, pages) !== undefined;
}

export function resolveWikiLinkTarget(
  target: string,
  anchor: string | null,
  lookup: WikiLinkPagesInput,
): DocLinkTarget | ExternalLinkTarget | AssetLinkTarget | null {
  const classified = classifyWikiLinkTarget(target, anchor);
  if (classified === null || classified.kind !== 'asset') return classified;

  const asset = resolveWikiLinkAssetTarget(
    classified.url,
    getAssetPathsSet(lookup),
    getFilePathsSet(lookup),
  );
  if (asset !== null) return classified;

  if (resolveWikiLinkTargetDocName(target, lookup) === undefined) return classified;

  return {
    kind: 'doc',
    docName: target.trim(),
    anchor: anchor?.trim() || null,
  };
}
