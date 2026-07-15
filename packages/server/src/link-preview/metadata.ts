/**
 * Assemble the external link-preview card and fetch its one image — the favicon
 * — first-party through the SSRF-guarded chokepoint. The favicon is the sole
 * exception to "no remote bytes in the card": the server fetches it, decides its
 * type by sniffing magic bytes (never the response's own `Content-Type`), and
 * returns it as a self-contained `data:` URI so the renderer issues no network
 * request for it. Any favicon failure is a partial success — the metadata is
 * returned without the icon rather than failing the whole card.
 */

import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import {
  type GuardedFetchOptions,
  type GuardedFetchResult,
  guardedFetch,
} from './guarded-fetch.ts';
import { deriveDomain, extractHtmlMetadata } from './html-metadata.ts';

/** Favicons are small; a response larger than this is almost certainly not one. */
const FAVICON_MAX_BYTES = 100 * 1024;

/**
 * Favicon fetch budget, deliberately shorter than the page fetch's 5s default.
 * The favicon is non-essential (its failure degrades to a partial success), so
 * a slow icon host must not be allowed to double a hover's worst-case latency.
 */
const FAVICON_TIMEOUT_MS = 2500;

/**
 * The SSRF-guarded fetch seam. Production passes the real {@link guardedFetch};
 * tests substitute a function that returns chosen bytes so the sniff + data-URI
 * assembly can be exercised without real network I/O.
 */
export type GuardedFetch = (
  url: string,
  options?: GuardedFetchOptions,
) => Promise<GuardedFetchResult>;

/**
 * Identify a raster image from its leading bytes, returning the media type for
 * the data URI or `null` for anything unrecognized. The type is decided by the
 * bytes, not by any server-supplied header, so a hostile origin cannot pass off
 * non-image bytes (e.g. HTML) as an image the renderer would treat as trusted.
 * SVG is intentionally excluded: it carries no fixed magic number and can embed
 * script, unlike these fixed-signature raster formats.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) {
    return 'image/x-icon';
  }
  return null;
}

function isImageContentType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Resolve the favicon URL: the parsed `<link rel=icon>` href (relative or
 * absolute) against the page URL, else the origin's `/favicon.ico`. Returns
 * `null` when a hostile href fails to parse, so no fetch is attempted.
 */
function resolveFaviconUrl(faviconHref: string | undefined, baseUrl: string): string | null {
  try {
    return new URL(faviconHref ?? '/favicon.ico', baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchFavicon(
  faviconUrl: string,
  fetchImpl: GuardedFetch,
): Promise<string | undefined> {
  const result = await fetchImpl(faviconUrl, {
    allowContentType: isImageContentType,
    maxBytes: FAVICON_MAX_BYTES,
    // Shorter than the page fetch's 5s so a single hover's outbound work is
    // bounded at ~7.5s worst case (5s page + 2.5s favicon) rather than ~10s.
    timeoutMs: FAVICON_TIMEOUT_MS,
  });
  if (!result.ok) return undefined;
  const mimeType = sniffImageMime(result.body);
  if (!mimeType) return undefined;
  return `data:${mimeType};base64,${Buffer.from(result.body).toString('base64')}`;
}

export interface BuildLinkPreviewMetadataInput {
  /** Decoded HTML body of the fetched page. */
  html: string;
  /** The URL the user hovered; the shown domain is derived from this. */
  requestUrl: string;
  /** The post-redirect URL the HTML came from; the favicon resolves against it. */
  finalUrl: string;
  /** SSRF-guarded fetch used for the favicon; defaults to the real chokepoint. */
  fetch?: GuardedFetch;
}

/**
 * Parse the page head, fetch + validate the favicon, and assemble the card's
 * metadata. The domain is always present (from the request URL); every other
 * field is included only when non-empty, so a bare page yields `{ domain }`.
 * This never throws: the parse, domain derivation, and guarded fetch each
 * absorb their own failures.
 */
export async function buildLinkPreviewMetadata(
  input: BuildLinkPreviewMetadataInput,
): Promise<LinkPreviewMetadata> {
  const fields = extractHtmlMetadata(input.html);
  const faviconUrl = resolveFaviconUrl(fields.faviconHref, input.finalUrl);
  const faviconDataUri = faviconUrl
    ? await fetchFavicon(faviconUrl, input.fetch ?? guardedFetch)
    : undefined;

  return {
    domain: deriveDomain(input.requestUrl),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.siteName !== undefined ? { siteName: fields.siteName } : {}),
    ...(faviconDataUri !== undefined ? { faviconDataUri } : {}),
  };
}
