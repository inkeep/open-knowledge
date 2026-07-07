import { describe, expect, mock, test } from 'bun:test';

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};
let _lastCapture: CaptureOpts | null = null;

mock.module('../../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'updater-1',
}));

const BETA_DMG_URL =
  'https://github.com/inkeep/open-knowledge/releases/download/v0.20.0-beta.4/OpenKnowledge-arm64.dmg';
// Mutable so a test can flip the beta resolver from a fresh tag to a fallback.
type BetaRedirect = { kind: string; url: string; cause?: string };
let _betaRedirect: BetaRedirect = { kind: 'fresh', url: BETA_DMG_URL };
mock.module('../../../../lib/download-links.ts', () => ({
  createBetaResolver: () => () => Promise.resolve(_betaRedirect),
}));

const { GET } = await import('./route.ts');
const REL = 'https://github.com/inkeep/open-knowledge/releases';

function call(
  channel: string,
  path: string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return GET(
    new Request(`https://openknowledge.ai/updates/${channel}/${path.join('/')}`, { headers }),
    {
      params: Promise.resolve({ channel, path }),
    },
  );
}

describe('GET /updates/[channel]/[...path]', () => {
  test('stable manifest 302s to the latest alias and is NOT counted', async () => {
    _lastCapture = null;
    const res = await call('stable', ['latest-mac.yml']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/latest/download/latest-mac.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('beta manifest 302s to the resolved beta tag and is NOT counted', async () => {
    _betaRedirect = { kind: 'fresh', url: BETA_DMG_URL };
    _lastCapture = null;
    const res = await call('beta', ['beta-mac.yml']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0-beta.4/beta-mac.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('stable zip 302s to the tagged release and counts app_update_downloaded', async () => {
    _lastCapture = null;
    const file = 'OpenKnowledge-0.20.0-arm64-mac.zip';
    const res = await call('stable', [file], { 'x-ok-from-version': '0.19.1' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0/${file}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(_lastCapture?.event).toBe('app_update_downloaded');
    expect(_lastCapture?.properties?.channel).toBe('stable');
    expect(_lastCapture?.properties?.artifact_type).toBe('zip');
    expect(_lastCapture?.properties?.to_version).toBe('0.20.0');
    expect(_lastCapture?.properties?.from_version).toBe('0.19.1');
  });

  test('beta zip parses the prerelease version and counts (no from_version header)', async () => {
    _lastCapture = null;
    const file = 'OpenKnowledge-0.20.0-beta.4-arm64-mac.zip';
    const res = await call('beta', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0-beta.4/${file}`);
    expect(_lastCapture?.properties?.to_version).toBe('0.20.0-beta.4');
    expect(_lastCapture?.properties?.from_version).toBeUndefined();
  });

  test('blockmap 302s but is NOT counted', async () => {
    _lastCapture = null;
    const file = 'OpenKnowledge-0.20.0-arm64-mac.zip.blockmap';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0/${file}`);
    expect(_lastCapture).toBeNull();
  });

  test('human dmg 302s (latest alias) but is NOT counted', async () => {
    _lastCapture = null;
    const res = await call('stable', ['OpenKnowledge-arm64.dmg']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/latest/download/OpenKnowledge-arm64.dmg`);
    expect(_lastCapture).toBeNull();
  });

  test('dmg blockmap 302s (latest alias) but is NOT counted', async () => {
    _lastCapture = null;
    const file = 'OpenKnowledge-arm64.dmg.blockmap';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/latest/download/${file}`);
    expect(_lastCapture).toBeNull();
  });

  test('invalid channel → 404', async () => {
    expect((await call('canary', ['latest-mac.yml'])).status).toBe(404);
  });

  test('path traversal / multi-segment → 404', async () => {
    expect((await call('stable', ['..', 'secret'])).status).toBe(404);
  });

  test('unknown artifact type → 404', async () => {
    expect((await call('stable', ['random.txt'])).status).toBe(404);
  });

  test('x64 zip parses the version and counts', async () => {
    _lastCapture = null;
    const file = 'OpenKnowledge-0.20.0-x64-mac.zip';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0/${file}`);
    expect(_lastCapture?.properties?.to_version).toBe('0.20.0');
  });

  test('beta manifest 503s (no-store) on resolver fallback, not counted', async () => {
    _betaRedirect = { kind: 'fallback', url: REL, cause: 'API error' };
    _lastCapture = null;
    const res = await call('beta', ['beta-mac.yml']);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(_lastCapture).toBeNull();
    _betaRedirect = { kind: 'fresh', url: BETA_DMG_URL };
  });
});
