import {
  type AssetLinkTarget,
  classifyWikiLinkTarget,
  type DocLinkTarget,
  type ExternalLinkTarget,
} from './link-targets.ts';
import { toWikiLinkSlug } from './slug.ts';
import { compareSpellings, leafKey, wikiAssetPathKey } from './target-identity.ts';
import { asTargetNamespace, resolveName } from './target-namespace.ts';

export interface WikiLinkLookupIndex {
  readonly pages: ReadonlySet<string>;
  readonly pagesBySlug: ReadonlyMap<string, string>;
  readonly pagesByBasename?: ReadonlyMap<string, string>;
  readonly assetPaths?: ReadonlySet<string>;
  readonly assetTargetKeys?: ReadonlySet<string>;
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

export function buildPagesBySlugIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const page of pages) {
    const key = slugFn(page);
    const previous = index.get(key);
    if (key && (previous === undefined || compareSpellings(page, previous) < 0)) {
      index.set(key, page);
    }
  }
  return index;
}

export function buildPagesByBasenameIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const sorted = [...pages].sort(compareSpellings);
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
  let bestMatch: string | undefined;
  for (const page of input) {
    if (toWikiLinkSlug(page) !== targetSlug) continue;
    if (bestMatch === undefined || compareSpellings(page, bestMatch) < 0) bestMatch = page;
  }
  return bestMatch;
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
    if (bestMatch === undefined || compareSpellings(page, bestMatch) < 0) bestMatch = page;
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
  const viaIdentity = resolveName(pages, trimmed);
  if (viaIdentity !== undefined) return viaIdentity;
  const withoutMarkdownSuffix = trimmed.replace(/\.(md|mdx)$/i, '');
  if (withoutMarkdownSuffix !== trimmed) {
    const strippedMatch = resolveWikiLinkDocNameWithoutSuffixFallback(withoutMarkdownSuffix, input);
    if (strippedMatch !== undefined) return strippedMatch;
  }
  return resolveWikiLinkDocNameWithoutSuffixFallback(trimmed, input);
}

function resolveWikiLinkDocNameWithoutSuffixFallback(
  target: string,
  input: WikiLinkPagesInput,
): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  const pages = getPagesSet(input);
  const viaIdentity = resolveName(pages, trimmed);
  if (viaIdentity !== undefined) return viaIdentity;
  const viaSlug = slugLookup(trimmed, input);
  if (viaSlug) return viaSlug;
  for (const candidate of getWikiLinkResolutionCandidates(trimmed)) {
    const viaCandidate = resolveName(pages, candidate);
    if (viaCandidate !== undefined) return viaCandidate;
  }
  const folderIndexDocName = resolveFolderIndexDocName(trimmed, pages);
  if (folderIndexDocName) return folderIndexDocName;
  return basenameLookup(trimmed, input);
}

function resolveFolderIndexDocName(target: string, pages: ReadonlySet<string>): string | undefined {
  const canonical = resolveName(pages, `${target}/index`);
  if (canonical !== undefined) return canonical;
  const slashIndex = target.lastIndexOf('/');
  const leaf = slashIndex === -1 ? target : target.slice(slashIndex + 1);
  return leaf ? resolveName(pages, `${target}/${leaf}`) : undefined;
}

function normalizeAssetTarget(target: string): string {
  const trimmed = target.trim();
  const withoutHash = (trimmed.split('#')[0] ?? '').trim();
  const withoutQuery = (withoutHash.split('?')[0] ?? '').trim();
  return withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
}

function foldWikiAssetPaths(paths: Iterable<string>): Map<string, string> {
  const folded = new Map<string, string>();
  for (const path of paths) {
    const key = wikiAssetPathKey(path);
    const current = folded.get(key);
    if (current === undefined || compareSpellings(path, current) < 0) folded.set(key, path);
  }
  return folded;
}

export function createWikiAssetResolver(
  paths: Iterable<string>,
): (spelling: string) => string | undefined {
  const files = asTargetNamespace('file', paths);
  let folded: Map<string, string> | undefined;
  return (spelling) => {
    const resolved = files.resolve(spelling);
    if (resolved !== undefined) return resolved;
    folded ??= foldWikiAssetPaths(files);
    return folded.get(wikiAssetPathKey(spelling));
  };
}

export function resolveWikiLinkAssetTarget(
  target: string,
  assetPaths: ReadonlySet<string>,
  filePaths?: ReadonlySet<string>,
): string | null {
  const normalized = normalizeAssetTarget(target);
  if (!normalized) return null;

  const partitions: ReadonlyArray<ReadonlySet<string>> = filePaths
    ? [assetPaths, filePaths]
    : [assetPaths];

  for (const partition of partitions) {
    const resolved = createWikiAssetResolver(partition)(normalized);
    if (resolved !== undefined) return resolved;
  }

  if (normalized.includes('/')) return null;
  const targetLeaf = leafKey('file', normalized);
  const matches: string[] = [];
  for (const partition of partitions) {
    for (const path of partition) {
      const slash = path.lastIndexOf('/');
      const basename = slash === -1 ? path : path.slice(slash + 1);
      if (leafKey('file', basename) === targetLeaf) matches.push(path);
    }
  }
  if (matches.length === 0) return null;
  return matches.sort(compareSpellings)[0] ?? null;
}

export function buildWikiLinkAssetTargetKeys(
  ...partitions: ReadonlyArray<Iterable<string>>
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const partition of partitions) {
    for (const path of partition) {
      keys.add(`path:${wikiAssetPathKey(path)}`);
      keys.add(`basename:${leafKey('file', path.slice(path.lastIndexOf('/') + 1))}`);
    }
  }
  return keys;
}

export function isResolvedWikiLinkTarget(
  target: string,
  pages: WikiLinkPagesInput,
  assetPaths?: ReadonlySet<string>,
  filePaths?: ReadonlySet<string>,
): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  const normalizedAsset = normalizeAssetTarget(trimmed);
  const indexedAsset = isLookupIndex(pages) ? pages.assetTargetKeys : undefined;
  if (indexedAsset !== undefined) {
    if (
      indexedAsset.has(`path:${wikiAssetPathKey(normalizedAsset)}`) ||
      (!normalizedAsset.includes('/') &&
        indexedAsset.has(`basename:${leafKey('file', normalizedAsset)}`))
    )
      return true;
  } else if (
    resolveWikiLinkAssetTarget(
      trimmed,
      getAssetPathsSet(pages, assetPaths),
      getFilePathsSet(pages, filePaths),
    )
  ) {
    return true;
  }

  return resolveWikiLinkTargetDocName(trimmed, pages) !== undefined;
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
