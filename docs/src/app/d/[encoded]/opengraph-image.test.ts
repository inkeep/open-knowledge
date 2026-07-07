import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

/**
 * The OG image route uses `next/og`'s `ImageResponse` which spins up satori
 * + resvg to render PNG bytes — heavy, network-dependent (it fetches the
 * DM Sans TTF from Google Fonts), and not the contract this test cares
 * about. We stub `next/og` here so the test asserts the route's plumbing
 * (Content-Type header, body has bytes, route maps each view kind to a
 * sensible body) without fighting third-party machinery. The actual PNG
 * fidelity gets verified in Playwright browser verification at story
 * landing time.
 */
const recordedCalls: Array<{
  body: unknown;
  options: { fonts?: unknown; headers?: Record<string, string>; width?: number; height?: number };
}> = [];

mock.module('next/og', () => ({
  ImageResponse: class MockImageResponse extends Response {
    constructor(
      body: unknown,
      options: {
        fonts?: unknown;
        headers?: Record<string, string>;
        width?: number;
        height?: number;
      },
    ) {
      super(new TextEncoder().encode(JSON.stringify({ tag: 'mock-og-bytes' })), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          ...options?.headers,
        },
      });
      recordedCalls.push({ body, options });
    }
  },
}));

const route = await import('./opengraph-image.tsx');
const { renderShareOgImage, size, contentType, alt, dynamic } = route;
const ogImage = route.default;

import { buildSplashViewModel, type SplashView } from '@/lib/share-splash';

function encodeV1(blobUrl: string): string {
  const bytes = new TextEncoder().encode(blobUrl);
  const combined = new Uint8Array([0x01, ...bytes]);
  let binary = '';
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

beforeAll(() => {
  recordedCalls.length = 0;
});

afterAll(() => {
  recordedCalls.length = 0;
});

describe('opengraph-image route metadata', () => {
  test('exports the OG-image segment metadata Next.js requires', () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe('image/png');
    expect(alt).toBe('Open in OpenKnowledge');
    expect(dynamic).toBe('force-static');
  });

  test('default export is the route handler', () => {
    expect(typeof ogImage).toBe('function');
  });
});

describe('renderShareOgImage', () => {
  function okView(blobUrl: string): SplashView {
    return buildSplashViewModel(encodeV1(blobUrl));
  }

  test('returns Content-Type image/png with non-empty body for a valid encoded fixture', async () => {
    const view = okView('https://github.com/inkeep/playbooks/blob/main/marketing-playbook.md');
    const response = renderShareOgImage(view, null);

    expect(response.headers.get('Content-Type')).toBe('image/png');

    const body = await response.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  test('sets the immutable forever cache header per spec', () => {
    const view = okView('https://github.com/o/r/blob/main/file.md');
    const response = renderShareOgImage(view, null);

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test('routes through ImageResponse with size 1200×630', () => {
    recordedCalls.length = 0;
    const view = okView('https://github.com/o/r/blob/main/file.md');
    renderShareOgImage(view, null);

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].options.width).toBe(1200);
    expect(recordedCalls[0].options.height).toBe(630);
  });

  test('passes both DM Sans weights when fonts are loaded', () => {
    recordedCalls.length = 0;
    const view = okView('https://github.com/o/r/blob/main/file.md');
    const fakeFont = new ArrayBuffer(8);
    renderShareOgImage(view, { light: fakeFont, medium: fakeFont });

    const fontsArg = recordedCalls[0].options.fonts as
      | Array<{ name: string; weight: number; style: string }>
      | undefined;
    expect(fontsArg).toBeDefined();
    expect(fontsArg).toHaveLength(2);
    expect(fontsArg?.find((f) => f.weight === 300)?.name).toBe('DM Sans');
    expect(fontsArg?.find((f) => f.weight === 500)?.name).toBe('DM Sans');
  });

  test('omits the fonts arg when font load failed (renders with satori default)', () => {
    recordedCalls.length = 0;
    const view = okView('https://github.com/o/r/blob/main/file.md');
    renderShareOgImage(view, null);

    expect(recordedCalls[0].options.fonts).toBeUndefined();
  });

  test('renders a fallback card for unsupported-version views', () => {
    recordedCalls.length = 0;
    const view: SplashView = { kind: 'unsupported-version', version: 0x02 };
    const response = renderShareOgImage(view, null);

    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(recordedCalls).toHaveLength(1);
  });

  test('renders a fallback card for invalid views', () => {
    recordedCalls.length = 0;
    const view: SplashView = { kind: 'invalid' };
    const response = renderShareOgImage(view, null);

    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(recordedCalls).toHaveLength(1);
  });
});
