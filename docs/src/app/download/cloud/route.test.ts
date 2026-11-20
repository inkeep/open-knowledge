import { describe, expect, test, vi } from 'vitest';
import {
  CLOUD_DMG_ASSET_NAME,
  type PrereleaseRedirect,
  RELEASES_PAGE_URL,
} from '../../../lib/download-links.ts';

const TEST_DMG_URL = `https://github.com/inkeep/open-knowledge/releases/download/v0.89.13-cloud.17243/${CLOUD_DMG_ASSET_NAME}`;

let _redirect: PrereleaseRedirect = { kind: 'fresh', url: TEST_DMG_URL };

const actual = await vi.importActual<typeof import('../../../lib/download-links.ts')>(
  '../../../lib/download-links.ts',
);
vi.doMock('../../../lib/download-links.ts', () => ({
  ...actual,
  createCloudResolver: () => () => Promise.resolve(_redirect),
}));

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};
let _lastCapture: CaptureOpts | null = null;
vi.doMock('../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'visitor-9',
  attribution: () => ({ sec_fetch_site: 'none' }),
  isPrefetchRequest: (request: Request) => request.headers.get('sec-purpose') === 'prefetch',
}));

const { GET } = await import('./route.ts');

const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TEST_RELEASE_PAGE =
  'https://github.com/inkeep/open-knowledge/releases/tag/v0.89.13-cloud.17243';

function call(headers: Record<string, string> = { 'user-agent': MAC_SAFARI }): Promise<Response> {
  return GET(new Request('https://openknowledge.ai/download/cloud', { headers }));
}

describe('GET /download/cloud', () => {
  test('serves the Apple Silicon Cloud DMG and counts it on the cloud channel', async () => {
    _redirect = { kind: 'fresh', url: TEST_DMG_URL };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.distinctId).toBe('visitor-9');
    expect(_lastCapture?.properties).toMatchObject({
      channel: 'cloud',
      os: 'macos',
      arch: 'arm64',
      format: 'dmg',
    });
  });

  test('302 to the stale LKG URL and still counts', async () => {
    _redirect = { kind: 'stale-lkg', url: TEST_DMG_URL, refreshError: 'network down' };
    _lastCapture = null;
    const res = await call();
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(_lastCapture?.properties?.channel).toBe('cloud');
  });

  test('302 to the releases page on fallback is NOT counted as a download', async () => {
    _redirect = { kind: 'fallback', url: RELEASES_PAGE_URL, cause: 'no published cloud release' };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(RELEASES_PAGE_URL);
    expect(_lastCapture).toBeNull();
  });

  test('a prefetch still redirects but is NOT counted', async () => {
    _redirect = { kind: 'fresh', url: TEST_DMG_URL };
    _lastCapture = null;
    const res = await call({ 'sec-purpose': 'prefetch', 'user-agent': MAC_SAFARI });
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(_lastCapture).toBeNull();
  });

  test.each([
    ['Linux', LINUX_FIREFOX],
    ['an iPhone', IPHONE_SAFARI],
    ['a browser that sends no user agent', ''],
  ])(
    'sends %s to the newest Cloud release page, not the macOS DMG, and counts no DMG',
    async (_label, userAgent) => {
      _redirect = { kind: 'fresh', url: TEST_DMG_URL };
      _lastCapture = null;
      const res = await call(userAgent ? { 'user-agent': userAgent } : {});
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(TEST_RELEASE_PAGE);
      expect(_lastCapture).toBeNull();
    },
  );

  test('a redirect that depends on the browser is never cached for other visitors', async () => {
    _redirect = { kind: 'fresh', url: TEST_DMG_URL };
    for (const userAgent of [MAC_SAFARI, LINUX_FIREFOX]) {
      const res = await call({ 'user-agent': userAgent });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('vary')).toBe('user-agent');
    }
  });

  test('a Linux visitor on a fallback still gets the releases page', async () => {
    _redirect = { kind: 'fallback', url: RELEASES_PAGE_URL, cause: 'no published cloud release' };
    const res = await call({ 'user-agent': LINUX_FIREFOX });
    expect(res.headers.get('location')).toBe(RELEASES_PAGE_URL);
  });
});
