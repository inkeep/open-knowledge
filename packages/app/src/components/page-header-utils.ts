import {
  IMAGE_EXTENSIONS,
  isSafeUrl,
  parseWikiLink,
  toDesktopAssetHref,
} from '@inkeep/open-knowledge-core';

const MAX_VALUE_LENGTH = 2048;

const MAX_EMOJI_CODE_POINTS = 24;

type PageIconKind = 'emoji' | 'url' | 'path' | 'unsupported';

export interface ResolvedPageIcon {
  kind: PageIconKind;
  value: string;
}

export function resolvePageIcon(raw: unknown): ResolvedPageIcon {
  if (typeof raw !== 'string') return { kind: 'unsupported', value: '' };
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_VALUE_LENGTH) {
    return { kind: 'unsupported', value: '' };
  }

  if (isLikelyEmoji(trimmed)) {
    return { kind: 'emoji', value: trimmed };
  }

  const imageKind = classifyImageRef(trimmed);
  if (imageKind === 'url') {
    return { kind: 'url', value: trimmed };
  }
  if (imageKind === 'path') {
    return {
      kind: 'path',
      value: toDesktopAssetHref(
        `/api/asset?path=${encodeURIComponent(toContentDirRelative(trimmed))}`,
      ),
    };
  }
  return { kind: 'unsupported', value: '' };
}

export interface ResolvedPageCover {
  kind: 'url' | 'path' | 'unsupported';
  value: string;
}

export function pickCoverKey(map: Record<string, unknown>): 'banner' | 'cover' | null {
  if (resolvePageCover(map.banner).kind !== 'unsupported') return 'banner';
  if (resolvePageCover(map.cover).kind !== 'unsupported') return 'cover';
  return null;
}

export function parseFocalY(raw: unknown): number | null {
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function focalYToObjectPosition(y: number | null): string {
  if (y === null) return 'center';
  return `center ${Math.round(y * 100)}%`;
}

export function resolvePageCover(raw: unknown): ResolvedPageCover {
  if (typeof raw !== 'string') return { kind: 'unsupported', value: '' };
  const rawTrim = raw.trim();
  const wiki = parseWikiLink(rawTrim);
  const trimmed = wiki ? wiki.target : rawTrim;
  if (trimmed === '' || trimmed.length > MAX_VALUE_LENGTH) {
    return { kind: 'unsupported', value: '' };
  }
  const imageKind = classifyImageRef(trimmed);
  if (imageKind === 'url') {
    return { kind: 'url', value: trimmed };
  }
  if (imageKind === 'path') {
    return {
      kind: 'path',
      value: toDesktopAssetHref(
        `/api/asset?path=${encodeURIComponent(toContentDirRelative(trimmed))}`,
      ),
    };
  }
  return { kind: 'unsupported', value: '' };
}

function toContentDirRelative(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

function isLikelyEmoji(value: string): boolean {
  if (/\p{L}/u.test(value)) return false;
  if (value.includes('/')) return false;
  let codePointCount = 0;
  for (const _ of value) codePointCount++;
  if (codePointCount > MAX_EMOJI_CODE_POINTS) return false;
  const dotIdx = value.lastIndexOf('.');
  if (dotIdx > -1) {
    const ext = value.slice(dotIdx + 1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return false;
  }
  return true;
}

function classifyImageRef(value: string): 'url' | 'path' | 'unsupported' {
  const ext = extractExtension(value);
  if (!ext || !IMAGE_EXTENSIONS.has(ext)) return 'unsupported';

  const colonIdx = value.indexOf(':');
  const slashIdx = value.indexOf('/');
  const hasScheme = colonIdx > -1 && (slashIdx === -1 || colonIdx < slashIdx);

  if (hasScheme) {
    return isSafeUrl(value) ? 'url' : 'unsupported';
  }
  if (value.startsWith('//')) return 'unsupported';
  if (value.includes('?') || value.includes('#')) return 'unsupported';
  if (value.startsWith('../') || value.includes('/../')) return 'unsupported';
  return 'path';
}

function extractExtension(value: string): string | null {
  const lastSlash = value.lastIndexOf('/');
  const lastSegment = lastSlash > -1 ? value.slice(lastSlash + 1) : value;
  const queryIdx = lastSegment.search(/[?#]/);
  const filename = queryIdx > -1 ? lastSegment.slice(0, queryIdx) : lastSegment;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === filename.length - 1) return null;
  return filename.slice(dotIdx + 1).toLowerCase();
}
