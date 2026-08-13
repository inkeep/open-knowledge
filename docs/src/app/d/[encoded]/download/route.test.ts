import { describe, expect, test, vi } from 'vitest';

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

// Flip the decoded-share outcome per test.
let _viewKind: 'ok' | 'invalid' | 'unsupported-version' = 'ok';
vi.doMock('../../../../lib/share-splash.ts', () => ({
  buildSplashViewModel: () => ({ kind: _viewKind }),
  SPLASH_DOWNLOAD_URL: SPLASH_URL,
}));

vi.doMock('../../../../lib/deferred-share.ts', () => ({
  buildPendingShareCookie: (encoded: string) => ({ name: 'ok-pending-share', value: encoded }),
}));

const { GET } = await import('./route.ts');

function call(encoded: string, query = ''): Promise<Response> {
  return GET(new Request(`https://openknowledge.ai/d/${encoded}/download${query}`), {
    params: Promise.resolve({ encoded }),
  });
}

describe('GET /d/[encoded]/download', () => {
  test('picker request carries a valid share to the architecture picker', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const res = await call('valid-share', '?picker=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://openknowledge.ai/download?utm_content=share-splash',
    );
    expect(res.headers.get('set-cookie')).toContain('ok-pending-share=valid-share');
    // Reaching the picker is not a download event.
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

  // Links minted before the picker carried `?os=` alone; they must keep working
  // rather than silently falling back to the mac DMG on a Windows machine.
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

  // The share carry is the whole point of this route: a platform row that
  // pointed anywhere else would download fine and lose the share.
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
