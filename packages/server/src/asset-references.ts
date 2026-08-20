import { realpathSync, type Stats, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import {
  createCodeFenceTracker,
  decodeHrefPath,
  type InlineAssetMediaKind,
  LINKABLE_ASSET_EXTENSIONS,
  mediaKindForSidebarAssetExtension,
  resolveAssetProjectPath,
} from '@inkeep/open-knowledge-core';
import { isWithinContentDir } from './content-path.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { matchMarkdownLinks, matchWikiLinks } from './link-syntax.ts';
import { getLogger } from './logger.ts';

const log = getLogger('asset-references');

interface ReferencedAssetEntry {
  kind: 'asset';
  path: string;
  assetExt: string;
  mediaKind: InlineAssetMediaKind | null;
  size: number;
  modified: string;
  referencedBy: string[];
}

// HTML `href`/`src` attributes are a different syntax family from the
// markdown/wiki link grammar in link-syntax.ts, so this recognizer stays
// local.
const HTML_LINK_ATTR_RE =
  /<[\w:-]+\b[^>]*?\s+(?:href|src)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”|([^\s"'=<>`]+))/gi;

export function isRemoteOrOpaqueHref(href: string): boolean {
  return (
    href.startsWith('#') ||
    href.startsWith('//') ||
    href.startsWith('data:') ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  );
}

export function stripHrefDecorations(rawHref: string): string {
  const trimmed = rawHref.trim().replace(/^<(.+)>$/, '$1');
  const hashIndex = trimmed.indexOf('#');
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

/**
 * Whether a collected reference names a linkable asset, judged on the bytes the
 * resolver will actually use: a markdown destination is a URI, so its extension
 * only appears once escapes are resolved (`photo%2Ejpg` reads as extension-less
 * raw), while a wiki target is already literal.
 */
function isLocalAssetReference(ref: LocalAssetReference): boolean {
  const href = stripHrefDecorations(ref.href);
  if (!href || isRemoteOrOpaqueHref(href)) return false;
  const resolvedBytes = ref.literal ? href : decodeHrefPath(href);
  return LINKABLE_ASSET_EXTENSIONS.has(extname(resolvedBytes).slice(1).toLowerCase());
}

/**
 * Change-detection key for the referenced-asset cache. It must agree with the
 * collector it gates, so it carries the plane and reads extensions off resolved
 * bytes exactly as `extractLocalAssetReferences` does — a signature that
 * collapsed either distinction would report "unchanged" for an edit that moves
 * the reference to a different file, and the cache would serve a stale answer.
 */
export function assetReferenceSignature(markdown: string | null): string {
  if (!markdown) return '';
  // No second dedup here: `extractLocalAssetReferences` already keys its map on
  // the same (plane, href) pair, so a `Set` over these could only ever be a
  // no-op — and one spelled with a different separator than the map it shadows,
  // which reads as though the two enforce different conditions.
  return extractLocalAssetReferences(markdown)
    .filter(isLocalAssetReference)
    .map((ref) => `${ref.literal ? 'w' : 'm'}\0${ref.href}`)
    .sort()
    .join('\u0001');
}

export function assetReferencesChanged(
  previousMarkdown: string | null,
  persistedMarkdown: string,
): boolean {
  return assetReferenceSignature(previousMarkdown) !== assetReferenceSignature(persistedMarkdown);
}

function mediaKindForAssetPath(path: string): InlineAssetMediaKind | null {
  const ext = extname(path).slice(1).toLowerCase();
  return mediaKindForSidebarAssetExtension(ext);
}

function errnoCode(err: unknown): string | null {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
}

function collectHrefsFromLine(line: string, refs: Map<string, LocalAssetReference>): void {
  const add = (href: string, literal: boolean): void => {
    // Key on the plane too, not the bytes alone. The same byte string authored
    // both ways names two DIFFERENT files — `![[100%20done.png]]` is a literal
    // filename while `[x](100%20done.png)` decodes to `100 done.png` — so
    // deduping on `href` would silently drop one real reference, re-collapsing
    // at dedup time the very distinction this collector carries. Emitting both
    // adds no duplicate downstream: `collectReferencedAssets` keys its output by
    // RESOLVED path, and the two resolve apart. First writer still wins within a
    // plane, so the map stays insertion-ordered like the Set it replaced.
    const key = `${literal ? 'w' : 'm'} ${href}`;
    if (!refs.has(key)) refs.set(key, { href, literal });
  };
  // nestedBracketLabels keeps the pre-consolidation preference for the
  // OUTER destination of badge-style `[![alt](img)](file.pdf)` links —
  // the linked file counts as the referenced asset, not the inner image.
  for (const match of matchMarkdownLinks(line, { nestedBracketLabels: true })) {
    if (match.href) add(match.href, false);
  }
  // A wiki target is a literal filename, not a URI — `![[100%20done.png]]`
  // names a file whose name really contains those three characters. Collapsing
  // both forms into one untagged list is what let the plane get lost between
  // recognition and resolution.
  for (const match of matchWikiLinks(line)) {
    add(match.target, true);
  }
  for (const match of line.matchAll(HTML_LINK_ATTR_RE)) {
    const href = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (href) add(href, false);
  }
}

function stripHtmlComments(line: string, state: { inComment: boolean }): string {
  let rest = line;
  let visible = '';
  while (rest.length > 0) {
    if (state.inComment) {
      const end = rest.indexOf('-->');
      if (end === -1) return visible;
      rest = rest.slice(end + 3);
      state.inComment = false;
      continue;
    }
    const start = rest.indexOf('<!--');
    if (start === -1) return visible + rest;
    visible += rest.slice(0, start);
    rest = rest.slice(start + 4);
    state.inComment = true;
  }
  return visible;
}

/**
 * One authored asset reference plus the plane its bytes live on. The plane is
 * decided at recognition time (by the syntax that produced the reference) and
 * carried to resolution, because `resolveAssetProjectPath` cannot recover it.
 */
interface LocalAssetReference {
  href: string;
  /** `true` for wiki targets (literal filename), `false` for markdown/HTML URIs. */
  literal: boolean;
}

function extractLocalAssetReferences(markdown: string): LocalAssetReference[] {
  const refs = new Map<string, LocalAssetReference>();
  const isInCodeFence = createCodeFenceTracker();
  const htmlCommentState = { inComment: false };
  for (const rawLine of markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (isInCodeFence(rawLine)) continue;
    const line = stripHtmlComments(rawLine, htmlCommentState).replace(/`[^`]*`/g, '');
    collectHrefsFromLine(line, refs);
  }
  return [...refs.values()];
}

export function extractLocalAssetHrefs(markdown: string): string[] {
  return extractLocalAssetReferences(markdown).map((ref) => ref.href);
}

interface ResolvedReferencedAsset {
  absolutePath: string;
  relativePath: string;
  stat: Stats;
}

function resolveReferencedAssetWithinContentDir(args: {
  contentDir: string;
  fromDocName: string;
  href: string;
  literal: boolean;
}): ResolvedReferencedAsset | null {
  const href = stripHrefDecorations(args.href);
  if (!href || isRemoteOrOpaqueHref(href)) return null;

  // Read the extension off the RESOLVED path, not the raw href: on the markdown
  // plane the resolver decodes, so an escaped extension dot (`photo%2Ejpg`)
  // only looks like an extension after resolution.
  const relativeAssetPath = resolveAssetProjectPath(href, args.fromDocName, {
    literal: args.literal,
  });
  if (!relativeAssetPath) return null;
  const ext = extname(relativeAssetPath).slice(1).toLowerCase();
  if (!LINKABLE_ASSET_EXTENSIONS.has(ext)) return null;
  const requestedPath = resolve(args.contentDir, relativeAssetPath);
  let canonicalPath: string;
  let stat: Stats;
  try {
    canonicalPath = normalize(realpathSync(requestedPath));
    if (!isWithinContentDir(canonicalPath, args.contentDir)) return null;
    stat = statSync(canonicalPath);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log.warn({ href: args.href, err }, 'unexpected error resolving asset');
    }
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    absolutePath: canonicalPath,
    relativePath: toContentRelativePath(args.contentDir, canonicalPath),
    stat,
  };
}

export function resolveReferencedAssetPath(args: {
  contentDir: string;
  fromDocName: string;
  href: string;
  /** Wiki plane (literal filename) vs markdown/HTML plane (URI that decodes). */
  literal: boolean;
}): string | null {
  let contentDir: string;
  try {
    contentDir = normalize(realpathSync(args.contentDir));
  } catch (err) {
    log.warn({ err }, 'could not resolve content directory');
    return null;
  }
  return resolveReferencedAssetWithinContentDir({ ...args, contentDir })?.absolutePath ?? null;
}

export function toContentRelativePath(contentDir: string, absolutePath: string): string {
  const normalizedRoot = normalize(realpathSync(contentDir));
  const normalizedPath = normalize(absolutePath);
  return normalizedPath
    .slice(normalizedRoot.length + (normalizedRoot.endsWith(sep) ? 0 : 1))
    .split(sep)
    .join('/');
}

export function collectReferencedAssets(args: {
  contentDir: string;
  fileIndex: ReadonlyMap<string, FileIndexEntry>;
  readMarkdown: (path: string) => string | null;
  /**
   * Optional content-filter gate. Excluded assets (via `.gitignore` /
   * `.okignore`) are dropped so they do not appear in document listings —
   * keeps the sidebar in sync with what `/api/asset` is allowed to serve.
   */
  isExcluded?: (relativePath: string) => boolean;
}): ReferencedAssetEntry[] {
  let contentDir: string;
  try {
    contentDir = normalize(realpathSync(args.contentDir));
  } catch (err) {
    log.warn({ err }, 'could not resolve content directory');
    return [];
  }
  const byPath = new Map<string, ReferencedAssetEntry>();
  for (const [docName, entry] of args.fileIndex) {
    const markdown = args.readMarkdown(entry.canonicalPath);
    if (markdown === null) continue;
    for (const ref of extractLocalAssetReferences(markdown)) {
      const asset = resolveReferencedAssetWithinContentDir({
        contentDir,
        fromDocName: docName,
        href: ref.href,
        literal: ref.literal,
      });
      if (!asset) continue;
      if (args.isExcluded?.(asset.relativePath)) continue;
      const mediaKind = mediaKindForAssetPath(asset.absolutePath);
      const existing = byPath.get(asset.relativePath);
      if (existing) {
        if (!existing.referencedBy.includes(docName)) existing.referencedBy.push(docName);
        continue;
      }
      byPath.set(asset.relativePath, {
        kind: 'asset',
        path: asset.relativePath,
        assetExt: extname(asset.relativePath).toLowerCase(),
        mediaKind,
        size: asset.stat.size,
        modified: asset.stat.mtime.toISOString(),
        referencedBy: [docName],
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
