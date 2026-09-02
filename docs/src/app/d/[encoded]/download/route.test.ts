import { describe, expect, test, vi } from 'vitest';
import fixture from '../../../../../../test-support/fixtures/share-url-v1-v2.json';

const SPLASH_URL =
  'https://github.com/inkeep/open-knowledge/releases/latest/download/OpenKnowledge-arm64.dmg';

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};
let _lastCapture: CaptureOpts | null = null;
let _isPrefetch = false;
vi.doMock('../../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'splash-1',
  attribution: () => ({ referrer: 'openknowledge.ai', utm_content: 'should-be-overridden' }),
  isPrefetchRequest: () => _isPrefetch,
}));

let _viewKind: 'ok' | 'invalid' | 'unsupported-version' = 'ok';
let _useRealShareContract = false;
vi.doMock('../../../../lib/share-splash.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/share-splash.ts')>();
  return {
    ...actual,
    buildSplashViewModel: (encoded: string) =>
      _useRealShareContract ? actual.buildSplashViewModel(encoded) : { kind: _viewKind },
    SPLASH_DOWNLOAD_URL: SPLASH_URL,
  };
});

vi.doMock('../../../../lib/deferred-share.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/deferred-share.ts')>();
  return {
    ...actual,
    buildPendingShareCookie: (encoded: string) =>
      _useRealShareContract
        ? actual.buildPendingShareCookie(encoded)
        : { name: 'ok-pending-share', value: encoded },
  };
});

const { GET } = await import('./route.ts');

function call(encoded: string, query = ''): Promise<Response> {
  return GET(new Request(`https://openknowledge.ai/d/${encoded}/download${query}`), {
    params: Promise.resolve({ encoded }),
  });
}

describe('GET /d/[encoded]/download', () => {
  test('maximum canonical v2 share crosses the real decoder and cookie builder', async () => {
    const canonicalV2 = fixture.bounds.maxCase;
    expect(canonicalV2.token).toHaveLength(3984);

    _useRealShareContract = true;
    _lastCapture = null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
    try {
      const res = await call(canonicalV2.token);
      const cookie = res.headers.get('set-cookie');

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(SPLASH_URL);
      expect(cookie).toBe(
        `ok_pending_share=${canonicalV2.token}; Path=/; Expires=Thu, 20 Aug 2026 00:00:00 GMT; Max-Age=604800; Secure; HttpOnly; SameSite=lax`,
      );
      expect(_lastCapture?.event).toBe('dmg_downloaded');
    } finally {
      _useRealShareContract = false;
      vi.useRealTimers();
    }
  });

  test('picker request carries a valid share to the architecture picker', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const res = await call('valid-share', '?picker=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://openknowledge.ai/download?utm_content=share-splash',
    );
    expect(res.headers.get('set-cookie')).toContain('ok-pending-share=valid-share');
    expect(_lastCapture).toBeNull();
  });

  test('invalid or unsupported picker request reaches the picker without a cookie', async () => {
    for (const kind of ['invalid', 'unsupported-version'] as const) {
      _viewKind = kind;
      _lastCapture = null;
      const res = await call(`${kind}-share`, '?picker=1');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://openknowledge.ai/download?utm_content=share-splash',
      );
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(_lastCapture).toBeNull();
    }
  });

  test('the full triple picks that exact build, cookie + count intact', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const res = await call('valid-share', '?os=linux&arch=arm64&format=rpm');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/latest/download/OpenKnowledge-aarch64.rpm',
    );
    expect(res.headers.get('set-cookie')).toContain('ok-pending-share=valid-share');
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.properties).toMatchObject({ os: 'linux', arch: 'arm64', format: 'rpm' });
  });

  test('a bare ?os= resolves to that OS default build', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const windows = await call('valid-share', '?os=windows');
    expect(windows.headers.get('location')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/latest/download/OpenKnowledge-Setup-x64.exe',
    );
    expect(_lastCapture?.properties).toMatchObject({ os: 'windows', arch: 'x64', format: 'exe' });

    const linux = await call('valid-share', '?os=linux');
    expect(linux.headers.get('location')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/latest/download/OpenKnowledge-amd64.deb',
    );
    expect(_lastCapture?.properties).toMatchObject({ os: 'linux', arch: 'x64', format: 'deb' });
  });

  test('an unrecognized ?os= retains the legacy macOS floor', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const res = await call('valid-share', '?os=beos');
    expect(res.headers.get('location')).toBe(SPLASH_URL);
    expect(_lastCapture?.properties).toMatchObject({ os: 'macos', arch: 'arm64', format: 'dmg' });
  });

  test('every platform row still sets the pairing cookie', async () => {
    _viewKind = 'ok';
    for (const query of [
      '?os=macos&arch=arm64&format=dmg',
      '?os=windows&arch=arm64&format=exe',
      '?os=linux&arch=x64&format=rpm',
    ]) {
      const res = await call('valid-share', query);
      expect(res.headers.get('set-cookie')).toContain('ok-pending-share=valid-share');
    }
  });

  test('a concrete-build prefetch still redirects (with cookie) but is NOT counted', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    _isPrefetch = true;
    try {
      const res = await call('valid-share', '?os=macos&arch=arm64&format=dmg');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(SPLASH_URL);
      expect(_lastCapture).toBeNull();
    } finally {
      _isPrefetch = false;
    }
  });
});
