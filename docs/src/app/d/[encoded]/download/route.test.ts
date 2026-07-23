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

function call(encoded: string): Promise<Response> {
  return GET(new Request(`https://openknowledge.ai/d/${encoded}/download`), {
    params: Promise.resolve({ encoded }),
  });
}

describe('GET /d/[encoded]/download', () => {
  test('valid share: 302 to the DMG, sets the pairing cookie, counts share-splash', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    const res = await call('valid-share');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SPLASH_URL);
    expect(res.headers.get('set-cookie')).toContain('ok-pending-share=valid-share');
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.properties?.channel).toBe('stable');
    // Server-authoritative: overrides the attribution() value.
    expect(_lastCapture?.properties?.utm_content).toBe('share-splash');
    expect(_lastCapture?.distinctId).toBe('splash-1');
  });

  test('invalid share: 302 with NO cookie but still counts the download', async () => {
    _viewKind = 'invalid';
    _lastCapture = null;
    const res = await call('bad-share');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SPLASH_URL);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.properties?.utm_content).toBe('share-splash');
  });

  test('unsupported-version share: no cookie, still counts', async () => {
    _viewKind = 'unsupported-version';
    _lastCapture = null;
    const res = await call('old-share');
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(_lastCapture?.event).toBe('dmg_downloaded');
  });

  test('a prefetch still redirects (with cookie) but is NOT counted', async () => {
    _viewKind = 'ok';
    _lastCapture = null;
    _isPrefetch = true;
    try {
      const res = await call('valid-share');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(SPLASH_URL);
      expect(_lastCapture).toBeNull();
    } finally {
      _isPrefetch = false;
    }
  });
});
