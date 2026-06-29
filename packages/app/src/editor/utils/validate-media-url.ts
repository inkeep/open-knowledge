
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  isLoomUrl,
  isVimeoUrl,
  parseYouTubeUrl,
  VIDEO_EXTENSIONS,
} from '@inkeep/open-knowledge-core';

type MediaKind = 'video' | 'audio' | 'image';

type EmbedProvider = 'youtube' | 'vimeo' | 'loom';

type MediaUrlValidationResult =
  | { valid: true }
  | { valid: false; reason: 'invalid-url' }
  | { valid: false; reason: 'embed-provider'; provider: EmbedProvider }
  | { valid: false; reason: 'data-uri' }
  | { valid: false; reason: 'wrong-extension'; extension: string };

const EXTENSIONS_BY_KIND: Record<MediaKind, ReadonlySet<string>> = {
  video: VIDEO_EXTENSIONS,
  audio: AUDIO_EXTENSIONS,
  image: IMAGE_EXTENSIONS,
};

const EMBED_PROVIDER_DOMAINS: Record<EmbedProvider, readonly string[]> = {
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  vimeo: ['vimeo.com'],
  loom: ['loom.com'],
};

function detectEmbedProvider(hostname: string): EmbedProvider | null {
  const lower = hostname.toLowerCase();
  for (const provider of Object.keys(EMBED_PROVIDER_DOMAINS) as EmbedProvider[]) {
    const domains = EMBED_PROVIDER_DOMAINS[provider];
    for (const d of domains) {
      if (lower === d || lower.endsWith(`.${d}`)) return provider;
    }
  }
  return null;
}

function getPathExtension(pathname: string): string {
  const lastSlash = pathname.lastIndexOf('/');
  const segment = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname;
  const lastDot = segment.lastIndexOf('.');
  return lastDot > 0 ? segment.slice(lastDot + 1).toLowerCase() : '';
}

const RELATIVE_PARSE_BASE = 'https://placeholder.invalid';

export function validateMediaUrl(input: string, kind: MediaKind): MediaUrlValidationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { valid: true };

  let parsed: URL;
  let isAbsolute = true;
  try {
    parsed = new URL(trimmed);
  } catch {
    try {
      parsed = new URL(trimmed, RELATIVE_PARSE_BASE);
      isAbsolute = false;
    } catch {
      return { valid: false, reason: 'invalid-url' };
    }
  }

  if (kind === 'video' && parseYouTubeUrl(trimmed) !== null) {
    return { valid: true };
  }
  if (kind === 'video' && isVimeoUrl(trimmed)) {
    return { valid: true };
  }
  if (kind === 'video' && isLoomUrl(trimmed)) {
    return { valid: true };
  }

  const embedProvider = isAbsolute ? detectEmbedProvider(parsed.hostname) : null;
  if (embedProvider !== null) {
    return { valid: false, reason: 'embed-provider', provider: embedProvider };
  }

  if (parsed.protocol === 'data:') {
    return { valid: false, reason: 'data-uri' };
  }

  const ext = getPathExtension(parsed.pathname);
  const allowed = EXTENSIONS_BY_KIND[kind];

  if (ext === '') {
    if (isAbsolute) return { valid: true };
    return { valid: false, reason: 'wrong-extension', extension: '' };
  }
  if (!allowed.has(ext)) {
    return { valid: false, reason: 'wrong-extension', extension: ext };
  }
  return { valid: true };
}

export function mediaKindForAccept(accept: readonly string[]): MediaKind | undefined {
  if (accept.length === 0) return undefined;
  const first = accept[0]?.toLowerCase() ?? '';
  if (first.startsWith('video/')) return 'video';
  if (first.startsWith('audio/')) return 'audio';
  if (first.startsWith('image/')) return 'image';
  return undefined;
}

export function mediaUrlPlaceholder(kind: MediaKind): string {
  const sample = Array.from(EXTENSIONS_BY_KIND[kind])
    .map((e) => `.${e}`)
    .join(', ');
  return `Direct ${kind} file URL — ${sample}`;
}

const PROVIDER_DISPLAY_NAMES: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
};

export function mediaUrlValidationMessage(
  result: MediaUrlValidationResult,
  kind: MediaKind,
): string {
  if (result.valid) return '';
  if (result.reason === 'invalid-url') return 'Not a valid URL.';
  if (result.reason === 'data-uri') {
    return 'Data URIs are not supported for media fields. Use a hosted file URL.';
  }
  if (result.reason === 'embed-provider') {
    const name = PROVIDER_DISPLAY_NAMES[result.provider];
    if (kind === 'video') {
      return `Unrecognized ${name} URL. Paste a valid ${name} share or embed link, or a direct ${kind} file URL.`;
    }
    return `${name} URLs are not direct ${kind} files. Paste a direct ${kind} file URL.`;
  }
  const accepted = Array.from(EXTENSIONS_BY_KIND[kind])
    .map((e) => `.${e}`)
    .join(', ');
  if (result.extension === '') {
    return `Missing file extension. Accepts: ${accepted}.`;
  }
  return `Unsupported extension .${result.extension}. Accepts: ${accepted}.`;
}
