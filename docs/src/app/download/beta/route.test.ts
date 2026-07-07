import { describe, expect, mock, test } from 'bun:test';
import {
  type BetaRedirect,
  DMG_ASSET_NAME,
  FALLBACK_CACHE_CONTROL,
  RELEASES_PAGE_URL,
  SUCCESS_CACHE_CONTROL,
} from '../../../lib/download-links.ts';

const TEST_DMG_URL = `https://github.com/inkeep/open-knowledge/releases/download/v0.1.0-beta.1/${DMG_ASSET_NAME}`;

// Mutable reference — each test sets this before calling GET so the injected
// resolver reflects the scenario under test.
let _redirect: BetaRedirect = { kind: 'fresh', url: TEST_DMG_URL };

// Mock must be registered before route.ts is loaded so the module-scope
// `createBetaResolver()` call in route.ts uses the injected resolver.
mock.module('../../../lib/download-links.ts', () => ({
  createBetaResolver: () => () => Promise.resolve(_redirect),
  toRedirectResponse: (r: BetaRedirect): Response =>
    new Response(null, {
      status: 302,
      headers: {
        location: r.url,
        'cache-control': r.kind === 'fallback' ? FALLBACK_CACHE_CONTROL : SUCCESS_CACHE_CONTROL,
      },
    }),
}));

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};
let _lastCapture: CaptureOpts | null = null;
mock.module('../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'visitor-9',
  referrerHostname: () => undefined,
}));

// Dynamic import ensures route.ts imports the mocked modules above.
const { GET } = await import('./route.ts');

function call(): Promise<Response> {
  return GET(new Request('https://openknowledge.ai/download/beta'));
}

describe('GET /download/beta', () => {
  test('302 to the fresh beta URL and fires dmg_downloaded (beta)', async () => {
    _redirect = { kind: 'fresh', url: TEST_DMG_URL };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(res.headers.get('cache-control')).toBe(SUCCESS_CACHE_CONTROL);
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.distinctId).toBe('visitor-9');
    expect(_lastCapture?.properties?.channel).toBe('beta');
  });

  test('302 to the stale LKG URL and still counts', async () => {
    _redirect = { kind: 'stale-lkg', url: TEST_DMG_URL, refreshError: 'network down' };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(res.headers.get('cache-control')).toBe(SUCCESS_CACHE_CONTROL);
    expect(_lastCapture?.properties?.channel).toBe('beta');
  });

  test('302 to the releases page on fallback is NOT counted as a download', async () => {
    _redirect = { kind: 'fallback', url: RELEASES_PAGE_URL, cause: 'API error' };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(RELEASES_PAGE_URL);
    expect(res.headers.get('cache-control')).toBe(FALLBACK_CACHE_CONTROL);
    expect(_lastCapture).toBeNull();
  });
});
