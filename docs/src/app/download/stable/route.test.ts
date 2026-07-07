import { describe, expect, mock, test } from 'bun:test';
import { STABLE_DMG_URL } from '../../../lib/download-links.ts';

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};

// Spy on the capture so we can assert the event without a PostHog round-trip.
// Registered before route.ts loads so its `@/lib/track` import resolves here.
let _lastCapture: CaptureOpts | null = null;
mock.module('../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'visitor-1',
  referrerHostname: () => 'news.ycombinator.com',
}));

const { GET } = await import('./route.ts');

describe('GET /download/stable', () => {
  test('302 to the stable DMG URL, uncached, and fires dmg_downloaded', () => {
    _lastCapture = null;
    const res = GET(new Request('https://openknowledge.ai/download/stable'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(STABLE_DMG_URL);
    // no-store so every download re-invokes the function and is counted.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(_lastCapture?.event).toBe('dmg_downloaded');
    expect(_lastCapture?.distinctId).toBe('visitor-1');
    expect(_lastCapture?.properties?.channel).toBe('stable');
    expect(_lastCapture?.properties?.referrer).toBe('news.ycombinator.com');
  });
});
