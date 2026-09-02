import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import {
  type GuardedFetchOptions,
  type GuardedFetchResult,
  guardedFetch,
} from './guarded-fetch.ts';
import { deriveDomain, extractHtmlMetadata } from './html-metadata.ts';

const FAVICON_MAX_BYTES = 100 * 1024;

const FAVICON_TIMEOUT_MS = 2500;

export type GuardedFetch = (
  url: string,
  options?: GuardedFetchOptions,
) => Promise<GuardedFetchResult>;

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
    timeoutMs: FAVICON_TIMEOUT_MS,
  });
  if (!result.ok) return undefined;
  const mimeType = sniffImageMime(result.body);
  if (!mimeType) return undefined;
  return `data:${mimeType};base64,${Buffer.from(result.body).toString('base64')}`;
}

export interface BuildLinkPreviewMetadataInput {
  html: string;
  requestUrl: string;
  finalUrl: string;
  fetch?: GuardedFetch;
}

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
