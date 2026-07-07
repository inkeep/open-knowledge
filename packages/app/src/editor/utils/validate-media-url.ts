/**
 * Render-layer URL validation for media-shaped string props (img.src,
 * video.src, video.poster, audio.src). Sibling concern to `sanitize-url.ts`:
 * that one strips XSS-class schemes; this one rejects URLs the browser
 * cannot decode as a media file of the expected kind — primarily
 * service-hosted watch pages that look right to the user but render as a
 * broken `<video>` element.
 */

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

// Single source of truth: the canonical sets in @inkeep/open-knowledge-core
// already declare what the rest of the pipeline accepts as renderable in
// each media kind. Adding a new extension upstream (e.g. .mkv → video,
// .flac → audio) propagates here automatically.
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

// Same shape as link-fidelity.ts's PLACEHOLDER_BASE — `.invalid` is the
// IANA-reserved TLD for placeholder hostnames (RFC 6761), and routing
// both relative-parse sites through the same string keeps the convention
// visible. Not literally imported (link-fidelity keeps it module-private)
// but value-aligned so a future hoist into a shared util is mechanical.
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

  // YouTube + Vimeo + Loom URLs the Video canonical can actually
  // render: delegate to the same helpers the renderer uses
  // (`parseYouTubeUrl`, `isVimeoUrl`, `isLoomUrl`) so validator and
  // renderer agree on host allowlists and URL shapes. Anything those
  // helpers reject falls through to the embed-provider rejection below
  // — kept around for any future provider we recognize as an embed host
  // but don't yet dispatch.
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

  // data: is NOT in sanitize-url.ts's SAFE_URL_SCHEMES, so the render-layer
  // sanitizer (sanitizeComponentProps, applied to src/poster at the
  // JsxComponentView boundary) rewrites a data: URI to "#". Passing it as
  // valid here would reproduce the exact silent-accept→broken-render bug
  // this module exists to prevent. Reject with a clear message instead.
  // Must precede the extensionless branch below — data: URI pathnames
  // carry no extension, so they'd otherwise slip through as valid.
  if (parsed.protocol === 'data:') {
    return { valid: false, reason: 'data-uri' };
  }

  const ext = getPathExtension(parsed.pathname);
  const allowed = EXTENSIONS_BY_KIND[kind];

  if (ext === '') {
    // Absolute non-embed-provider URLs without a path extension (signed CDN
    // URLs like Firebase Storage, Cloudinary transforms, S3 with /v1/assets/<uuid>)
    // load fine — the browser reads Content-Type from the response, not the URL.
    // Relative paths without an extension don't have that fallback, so they
    // stay rejected. Embed-provider hosts already returned above.
    if (isAbsolute) return { valid: true };
    return { valid: false, reason: 'wrong-extension', extension: '' };
  }
  if (!allowed.has(ext)) {
    return { valid: false, reason: 'wrong-extension', extension: ext };
  }
  return { valid: true };
}

/**
 * Bridge descriptor-declared `propDef.accept` (MIME-type array) to a
 * `MediaKind`. Returns `undefined` for empty / non-media accept arrays
 * (PdfProps' application/pdf, FileProps' all-types accept) — PropPanel
 * reads `undefined` as the signal "skip URL validation and the
 * placeholder machinery entirely."
 *
 * Routes off `accept[0]`'s top-level type prefix; the built-ins author
 * single-kind accept arrays today.
 */
export function mediaKindForAccept(accept: readonly string[]): MediaKind | undefined {
  if (accept.length === 0) return undefined;
  const first = accept[0]?.toLowerCase() ?? '';
  if (first.startsWith('video/')) return 'video';
  if (first.startsWith('audio/')) return 'audio';
  if (first.startsWith('image/')) return 'image';
  return undefined;
}

/**
 * Placeholder text for the input. Names every accepted extension for the
 * given kind — the canonical sets are at most 7 members each, so the full
 * list stays readable.
 */
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

/**
 * User-facing error message derived from a validation result. Returns the
 * empty string when the result is valid (callers branch on result.valid
 * directly; this helper exists for the message-rendering site).
 */
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
      // YouTube + Vimeo + Loom all dispatch via the renderer's helpers,
      // so on the video kind we only land here when the URL was
      // recognized as one of those provider hosts but the ID / path /
      // `?t=` grammar didn't pass (i.e., malformed share / embed
      // URL). Tell the user the provider IS supported but the URL
      // shape isn't.
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
