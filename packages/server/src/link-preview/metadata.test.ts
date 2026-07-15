import { describe, expect, test } from 'bun:test';
import type { GuardedFetchOptions, GuardedFetchResult } from './guarded-fetch.ts';
import { buildLinkPreviewMetadata, type GuardedFetch } from './metadata.ts';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// Minimal valid magic-number headers for each accepted raster format.
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00);
const BMP = bytes(0x42, 0x4d, 0x10, 0x00, 0x00, 0x00);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
const ICO = bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00);
const HTML_BYTES = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');

function okResult(body: Uint8Array, contentType = 'image/png'): GuardedFetchResult {
  return { ok: true, body, contentType, finalUrl: 'https://site.example/favicon.ico' };
}

/** Injected fetch that returns a fixed result and records the URLs + options it saw. */
function recordingFetch(result: GuardedFetchResult): {
  fetch: GuardedFetch;
  calls: string[];
  options: Array<GuardedFetchOptions | undefined>;
} {
  const calls: string[] = [];
  const options: Array<GuardedFetchOptions | undefined> = [];
  const fetch: GuardedFetch = async (url, opts) => {
    calls.push(url);
    options.push(opts);
    return result;
  };
  return { fetch, calls, options };
}

const BASE = {
  requestUrl: 'https://site.example/page',
  finalUrl: 'https://site.example/page',
};

describe('buildLinkPreviewMetadata favicon', () => {
  test('encodes a validated image as a data URI whose bytes round-trip', async () => {
    const { fetch } = recordingFetch(okResult(PNG));
    const meta = await buildLinkPreviewMetadata({ html: '<html></html>', ...BASE, fetch });
    expect(meta.faviconDataUri).toStartWith('data:image/png;base64,');
    const decoded = new Uint8Array(Buffer.from(meta.faviconDataUri?.split(',')[1] ?? '', 'base64'));
    expect(decoded).toEqual(PNG);
  });

  const FORMATS: Array<[string, Uint8Array]> = [
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/bmp', BMP],
    ['image/webp', WEBP],
    ['image/x-icon', ICO],
  ];
  test.each(FORMATS)('sniffs %s from its magic bytes', async (mime, header) => {
    const { fetch } = recordingFetch(okResult(header, 'application/octet-stream'));
    const meta = await buildLinkPreviewMetadata({ html: '<html></html>', ...BASE, fetch });
    // The data-URI type comes from the sniffed bytes, not the response header.
    expect(meta.faviconDataUri).toStartWith(`data:${mime};base64,`);
  });

  test('rejects non-image bytes even when the response claims an image type', async () => {
    // Hostile origin: Content-Type says image/png, body is HTML/script.
    const { fetch } = recordingFetch(okResult(HTML_BYTES, 'image/png'));
    const meta = await buildLinkPreviewMetadata({ html: '<html></html>', ...BASE, fetch });
    expect(meta.faviconDataUri).toBeUndefined();
  });

  test('omits the favicon (partial success) when the guarded fetch fails', async () => {
    const { fetch } = recordingFetch({ ok: false, reason: 'timeout' });
    const meta = await buildLinkPreviewMetadata({
      html: '<html><head><title>Kept</title></head></html>',
      ...BASE,
      fetch,
    });
    expect(meta.faviconDataUri).toBeUndefined();
    expect(meta.title).toBe('Kept');
  });

  test('resolves a relative favicon href against the final (post-redirect) URL', async () => {
    const { fetch, calls } = recordingFetch(okResult(PNG));
    await buildLinkPreviewMetadata({
      html: '<html><head><link rel="icon" href="/assets/fav.png"></head></html>',
      requestUrl: 'https://site.example/page',
      finalUrl: 'https://cdn.site.example/landing',
      fetch,
    });
    expect(calls).toEqual(['https://cdn.site.example/assets/fav.png']);
  });

  test('falls back to /favicon.ico at the origin when no icon link is present', async () => {
    const { fetch, calls } = recordingFetch(okResult(PNG));
    await buildLinkPreviewMetadata({
      html: '<html><head><title>No icon link</title></head></html>',
      requestUrl: 'https://site.example/deep/page',
      finalUrl: 'https://site.example/deep/page',
      fetch,
    });
    expect(calls).toEqual(['https://site.example/favicon.ico']);
  });

  test('caps the favicon fetch with a shorter timeout than the page budget', async () => {
    // The favicon is non-essential, so its fetch is given a tighter 2.5s
    // deadline than the page fetch's 5s default — bounding a hover's worst case.
    const { fetch, options } = recordingFetch(okResult(PNG));
    await buildLinkPreviewMetadata({ html: '<html></html>', ...BASE, fetch });
    expect(options[0]?.timeoutMs).toBe(2500);
  });
});

describe('buildLinkPreviewMetadata assembly', () => {
  test('assembles every field for a fully-populated page', async () => {
    const { fetch } = recordingFetch(okResult(PNG));
    const html = `<html><head>
      <meta property="og:title" content="Example Title">
      <meta property="og:description" content="Example description.">
      <meta property="og:site_name" content="Example">
      <link rel="icon" href="/favicon.png">
    </head><body></body></html>`;
    const meta = await buildLinkPreviewMetadata({ html, ...BASE, fetch });
    expect(meta).toEqual({
      domain: 'site.example',
      title: 'Example Title',
      description: 'Example description.',
      siteName: 'Example',
      faviconDataUri: meta.faviconDataUri,
    });
    expect(meta.faviconDataUri).toStartWith('data:image/png;base64,');
  });

  test('yields domain-only when the page has no head tags and the favicon fails', async () => {
    const { fetch } = recordingFetch({ ok: false, reason: 'non-html' });
    const meta = await buildLinkPreviewMetadata({
      html: '<html><body>nothing</body></html>',
      requestUrl: 'https://www.example.org/x',
      finalUrl: 'https://www.example.org/x',
      fetch,
    });
    expect(meta).toEqual({ domain: 'example.org' });
  });
});
