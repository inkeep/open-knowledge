import { DEFAULT_DOC_EXTENSION } from '../constants/doc-extensions.ts';
import { type ResolvedInternalHref, resolveInternalHref } from './resolve-internal-href.ts';

export interface DocLinkTarget extends ResolvedInternalHref {
  kind: 'doc';
}

export interface ExternalLinkTarget {
  kind: 'external';
  url: string;
}

export interface AnchorLinkTarget {
  kind: 'anchor';
  anchor: string;
}

export interface AssetLinkTarget {
  kind: 'asset';
  url: string;
  ext: string;
}

export type ClassifiedLinkTarget =
  | DocLinkTarget
  | ExternalLinkTarget
  | AnchorLinkTarget
  | AssetLinkTarget;

export function assertNeverLinkTarget(value: never): never {
  throw new Error(`Unhandled ClassifiedLinkTarget variant: ${JSON.stringify(value as unknown)}`);
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function extractAssetExtension(href: string): string | null {
  const pathOnly = href.split(/[?#]/)[0] ?? href;
  const match = pathOnly.match(/\.([a-z0-9]+)$/i);
  return match ? (match[1] ?? '').toLowerCase() : null;
}

function splitDocNameSegments(docName: string): string[] {
  return docName.split('/').filter(Boolean);
}

export function isExternalHref(value: string): boolean {
  const trimmed = value.trim();
  return URI_SCHEME_RE.test(trimmed) || trimmed.startsWith('//');
}

export function classifyMarkdownHref(
  href: string,
  sourceDocName: string,
): ClassifiedLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    const anchor = trimmed.slice(1).trim();
    return anchor ? { kind: 'anchor', anchor } : null;
  }

  if (isExternalHref(trimmed)) {
    return { kind: 'external', url: trimmed };
  }

  const internal = resolveInternalHref(trimmed, sourceDocName);
  if (internal) {
    return {
      kind: 'doc',
      docName: internal.docName,
      anchor: internal.anchor,
    };
  }

  const ext = extractAssetExtension(trimmed);
  if (ext && ext !== 'md' && ext !== 'mdx') {
    return { kind: 'asset', url: trimmed, ext };
  }

  return null;
}

export function classifyWikiLinkTarget(
  target: string,
  anchor: string | null,
): DocLinkTarget | ExternalLinkTarget | AssetLinkTarget | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  if (isExternalHref(trimmed)) {
    return {
      kind: 'external',
      url: anchor ? `${trimmed}#${anchor}` : trimmed,
    };
  }

  const ext = extractAssetExtension(trimmed);
  if (ext && ext !== 'md' && ext !== 'mdx') {
    return { kind: 'asset', url: trimmed, ext };
  }

  return {
    kind: 'doc',
    docName: trimmed,
    anchor: anchor?.trim() || null,
  };
}

export function resolveAssetProjectPath(href: string, sourceDocName: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (URI_SCHEME_RE.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('#')) return null;

  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const cleanPath = (pathPart.split('?')[0] ?? '').trim();
  if (!cleanPath) return null;

  const isServerAbsolute = cleanPath.startsWith('/');
  const effectivePath = isServerAbsolute ? cleanPath.slice(1) : cleanPath;
  const dirParts: string[] = isServerAbsolute
    ? []
    : sourceDocName.includes('/')
      ? sourceDocName.split('/').slice(0, -1)
      : [];

  for (const seg of effectivePath.split('/')) {
    if (seg === '..') {
      if (dirParts.length === 0) return null;
      dirParts.pop();
    } else if (seg !== '.' && seg !== '') {
      dirParts.push(seg);
    }
  }

  if (dirParts.length === 0) return null;
  return dirParts.join('/');
}


export function buildRelativeMarkdownHref(
  sourceDocName: string,
  targetDocName: string,
  anchor: string | null = null,
  ext: string = DEFAULT_DOC_EXTENSION,
): string {
  const sourceDirSegments = splitDocNameSegments(sourceDocName);
  sourceDirSegments.pop();

  const targetSegments = splitDocNameSegments(targetDocName);

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < sourceDirSegments.length &&
    commonPrefixLength < targetSegments.length &&
    sourceDirSegments[commonPrefixLength] === targetSegments[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  const upSegments = sourceDirSegments.slice(commonPrefixLength).map(() => '..');
  const downSegments = targetSegments.slice(commonPrefixLength);
  let relativePath = [...upSegments, ...downSegments].join('/');

  relativePath ||= targetSegments.at(-1) ?? targetDocName;

  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    relativePath = `./${relativePath}`;
  }

  return `${relativePath}${ext}${anchor ? `#${anchor}` : ''}`;
}

export function buildAbsoluteMarkdownHref(
  docName: string,
  ext: string = DEFAULT_DOC_EXTENSION,
  anchor: string | null = null,
): string {
  return `/${docName}${ext}${anchor ? `#${anchor}` : ''}`;
}
