import { stripMdExt } from '../constants/cc1.ts';
import { SUPPORTED_DOC_EXTENSIONS } from '../constants/doc-extensions.ts';

export interface ResolvedInternalHref {
  docName: string;
  anchor: string | null;
}

export function decodeHrefPathSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  if (
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return segment;
  }
  return decoded;
}

export function encodeHrefPathSegment(segment: string): string {
  if (segment === '.' || segment === '..') return segment;
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.codePointAt(0)?.toString(16).toUpperCase()}`,
  );
}

export function encodeHrefPath(path: string): string {
  return path.split('/').map(encodeHrefPathSegment).join('/');
}

export function decodeHrefPath(path: string): string {
  return path.split('/').map(decodeHrefPathSegment).join('/');
}

export function resolveInternalHref(
  href: string,
  sourceDocName: string,
): ResolvedInternalHref | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return null;

  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const anchor = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : null;

  const cleanPath = (pathPart.split('?')[0] ?? '').trim();
  if (!cleanPath) return null;

  const lastSegment = decodeHrefPathSegment(cleanPath.split('/').pop() ?? '');
  const extMatch = lastSegment.match(/\.([a-z0-9]+)$/i);
  if (extMatch) {
    const ext = `.${(extMatch[1] ?? '').toLowerCase()}`;
    if (!(SUPPORTED_DOC_EXTENSIONS as readonly string[]).includes(ext)) return null;
  }

  const isRootRelative = cleanPath.startsWith('/');
  const effectivePath = isRootRelative ? cleanPath.slice(1) : cleanPath;
  const dirParts = isRootRelative
    ? []
    : sourceDocName.includes('/')
      ? sourceDocName.split('/').slice(0, -1)
      : [];

  const segments = effectivePath.split('/');
  const lastSegmentIndex = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    let seg = decodeHrefPathSegment(segments[i] ?? '');
    if (i === lastSegmentIndex) seg = stripMdExt(seg);
    if (seg === '..') {
      if (dirParts.length === 0) return null;
      dirParts.pop();
    } else if (seg !== '.' && seg !== '') {
      dirParts.push(seg);
    }
  }

  if (dirParts.length === 0) return null;
  return { docName: dirParts.join('/'), anchor: anchor || null };
}
