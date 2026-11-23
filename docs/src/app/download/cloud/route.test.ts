import { describe, expect, test, vi } from 'vitest';
import {
  CLOUD_DMG_ASSET_NAME,
  CLOUD_DOWNLOAD_PAGE_PATH,
  CLOUD_DOWNLOAD_TARGETS,
  CLOUD_RELEASES_PAGE_URL,
  type CloudDownloadTargetId,
  type PrereleaseRedirect,
} from '../../../lib/download-links.ts';

const TEST_TAG = 'v0.89.16-cloud.19223';

function assetUrl(assetName: string): string {
  return `https://github.com/inkeep/open-knowledge/releases/download/${TEST_TAG}/${assetName}`;
}

const TEST_DMG_URL = assetUrl(CLOUD_DMG_ASSET_NAME);

let _resolveOverride: ((id: CloudDownloadTargetId) => PrereleaseRedirect) | null = null;
let _defaultRedirect: PrereleaseRedirect = { kind: 'fresh', url: TEST_DMG_URL };

const actual = await vi.importActual<typeof import('../../../lib/download-links.ts')>(
  '../../../lib/download-links.ts',
);
vi.doMock('../../../lib/download-links.ts', () => ({
  ...actual,
  createCloudAssetsResolver: () => (id: CloudDownloadTargetId) =>
    Promise.resolve(_resolveOverride ? _resolveOverride(id) : _defaultRedirect),
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
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function call(
  headers: Record<string, string> = { 'user-agent': MAC_SAFARI },
  query = '',
): Promise<Response> {
  const suffix = query ? `?${query}` : '';
  return GET(new Request(`https://openknowledge.ai/download/cloud${suffix}`, { headers }));
}

describe('GET /download/cloud', () => {
  test('serves the Apple Silicon Cloud DMG for a Mac browser and counts it on the cloud channel', async () => {
    _resolveOverride = null;
    _defaultRedirect = { kind: 'fresh', url: TEST_DMG_URL };
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

  test('serves every explicit Cloud build target regardless of browser user agent and counts its os/arch/format', async () => {
    _resolveOverride = (id) => {
      const target = CLOUD_DOWNLOAD_TARGETS.find((entry) => entry.id === id);
      if (!target) throw new Error(`unexpected target ${id}`);
      return { kind: 'fresh', url: assetUrl(target.assetName) };
    };
    for (const target of CLOUD_DOWNLOAD_TARGETS) {
      _lastCapture = null;
      const res = await call(
        { 'user-agent': WINDOWS_CHROME },
        `utm_content=cloud-beta-download-page&os=${target.os}&arch=${target.arch}&format=${target.format}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(assetUrl(target.assetName));
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('vary')).toBeNull();
      expect(_lastCapture?.properties).toMatchObject({
        channel: 'cloud',
        os: target.os,
        arch: target.arch,
        format: target.format,
      });
    }
    _resolveOverride = null;
  });

  test('302 to the stale LKG URL and still counts', async () => {
    _resolveOverride = null;
    _defaultRedirect = { kind: 'stale-lkg', url: TEST_DMG_URL, refreshError: 'network down' };
    _lastCapture = null;
    const res = await call();
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(_lastCapture?.properties?.channel).toBe('cloud');
  });

  test('302 to the releases page on fallback is NOT counted as a download', async () => {
    _resolveOverride = null;
    _defaultRedirect = {
      kind: 'fallback',
      url: CLOUD_RELEASES_PAGE_URL,
      cause: 'no published cloud release',
    };
    _lastCapture = null;
    const res = await call();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(CLOUD_RELEASES_PAGE_URL);
    expect(_lastCapture).toBeNull();
  });

  test('a prefetch still redirects but is NOT counted', async () => {
    _resolveOverride = null;
    _defaultRedirect = { kind: 'fresh', url: TEST_DMG_URL };
    _lastCapture = null;
    const res = await call({ 'sec-purpose': 'prefetch', 'user-agent': MAC_SAFARI });
    expect(res.headers.get('location')).toBe(TEST_DMG_URL);
    expect(_lastCapture).toBeNull();
  });

  test.each([
    ['Linux', LINUX_FIREFOX],
    ['Windows', WINDOWS_CHROME],
    ['an iPhone', IPHONE_SAFARI],
    ['a browser that sends no user agent', ''],
  ])(
    'sends %s to the Cloud download picker page instead of GitHub Releases and counts no download',
    async (_label, userAgent) => {
      _resolveOverride = null;
      _defaultRedirect = { kind: 'fresh', url: TEST_DMG_URL };
      _lastCapture = null;
      const res = await call(userAgent ? { 'user-agent': userAgent } : {});
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(CLOUD_DOWNLOAD_PAGE_PATH);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('vary')).toBe('user-agent');
      expect(_lastCapture).toBeNull();
    },
  );

  test('preserves a safe utm_content slug when sending a non-Mac visitor to the picker and drops unsafe values', async () => {
    const safeRes = await call({ 'user-agent': LINUX_FIREFOX }, 'utm_content=cloud-beta-welcome');
    expect(safeRes.headers.get('location')).toBe(
      `${CLOUD_DOWNLOAD_PAGE_PATH}?utm_content=cloud-beta-welcome`,
    );

    const unsafeRes = await call(
      { 'user-agent': LINUX_FIREFOX },
      'utm_content=https://evil.example/%0d%0a',
    );
    expect(unsafeRes.headers.get('location')).toBe(CLOUD_DOWNLOAD_PAGE_PATH);
  });

  test('sends an unsupported explicit target to the Cloud download picker page', async () => {
    _lastCapture = null;
    const res = await call(
      { 'user-agent': MAC_SAFARI },
      'os=windows&arch=x64&format=exe&utm_content=cloud-beta-welcome',
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${CLOUD_DOWNLOAD_PAGE_PATH}?utm_content=cloud-beta-welcome`,
    );
    expect(_lastCapture).toBeNull();
  });

  test('a UA-dependent redirect is never cached for other visitors', async () => {
    _resolveOverride = null;
    _defaultRedirect = { kind: 'fresh', url: TEST_DMG_URL };
    for (const userAgent of [MAC_SAFARI, LINUX_FIREFOX]) {
      const res = await call({ 'user-agent': userAgent });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('vary')).toBe('user-agent');
    }
  });
});
