import { beforeEach, describe, expect, test, vi } from 'vitest';

type CaptureOpts = {
  event: string;
  distinctId: string;
  properties?: Record<string, string | undefined>;
};
let _lastCapture: CaptureOpts | null = null;

vi.doMock('../../../../lib/track.ts', () => ({
  captureServerEvent: (opts: CaptureOpts) => {
    _lastCapture = opts;
  },
  resolveDistinctId: () => 'updater-1',
  userAgentProperties: () => ({ ua_class: 'electron' }),
}));

const REL = 'https://github.com/inkeep/open-knowledge/releases';

function makeRelease(
  tag: string,
  opts: { prerelease: boolean; draft?: boolean; assetNames: string[] },
) {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease,
    assets: opts.assetNames.map((name) => ({
      name,
      browser_download_url: `${REL}/download/${tag}/${name}`,
    })),
  };
}

const DEFAULT_RELEASES = [
  makeRelease('v1.0.0', {
    prerelease: false,
    assetNames: ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'],
  }),
  makeRelease('v1.0.0-beta.2', {
    prerelease: true,
    assetNames: [
      'beta.yml',
      'beta-mac.yml',
      'beta-linux.yml',
      'beta-linux-arm64.yml',
      'beta-product.yml',
      'beta-product-mac.yml',
      'beta-product-linux.yml',
      'beta-product-linux-arm64.yml',
    ],
  }),
  makeRelease('v0.89.18', {
    prerelease: false,
    assetNames: ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'],
  }),
  makeRelease('v0.89.18-beta.1', {
    prerelease: true,
    assetNames: [
      'beta.yml',
      'beta-mac.yml',
      'beta-linux.yml',
      'beta-linux-arm64.yml',
      'beta-product.yml',
      'beta-product-mac.yml',
      'beta-product-linux.yml',
      'beta-product-linux-arm64.yml',
    ],
  }),
];

type RedirectOverride = { kind: string; url: string; cause?: string; refreshError?: string };
let _releasesPayload: unknown = DEFAULT_RELEASES;
let _overrideRedirect: RedirectOverride | null = null;
let _lastSelected: { kind: 'stable' | 'beta'; assetName: string; major?: number } | undefined;
let _clock = 0;
let _resolverEpoch = 0;

const actualDownloadLinks = await vi.importActual<
  typeof import('../../../../lib/download-links.ts')
>('../../../../lib/download-links.ts');

const mockFetch: typeof fetch = async () =>
  new Response(JSON.stringify(_releasesPayload), { status: 200 });

vi.doMock('../../../../lib/download-links.ts', () => ({
  ...actualDownloadLinks,
  createBetaResolver: ({ assetName, major }: { assetName?: string; major?: number } = {}) => {
    let epoch = -1;
    let real = actualDownloadLinks.createBetaResolver({
      assetName,
      major,
      fetchImpl: mockFetch,
      now: () => _clock,
    });
    return () => {
      _lastSelected = { kind: 'beta', assetName: assetName ?? '', major };
      if (_overrideRedirect) return Promise.resolve(_overrideRedirect);
      if (epoch !== _resolverEpoch) {
        epoch = _resolverEpoch;
        real = actualDownloadLinks.createBetaResolver({
          assetName,
          major,
          fetchImpl: mockFetch,
          now: () => _clock,
        });
      }
      return real();
    };
  },
  createStableResolver: ({ assetName, major }: { assetName: string; major: number }) => {
    let epoch = -1;
    let real = actualDownloadLinks.createStableResolver({
      assetName,
      major,
      fetchImpl: mockFetch,
      now: () => _clock,
    });
    return () => {
      _lastSelected = { kind: 'stable', assetName, major };
      if (_overrideRedirect) return Promise.resolve(_overrideRedirect);
      if (epoch !== _resolverEpoch) {
        epoch = _resolverEpoch;
        real = actualDownloadLinks.createStableResolver({
          assetName,
          major,
          fetchImpl: mockFetch,
          now: () => _clock,
        });
      }
      return real();
    };
  },
}));

const { GET } = await import('./route.ts');

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

beforeEach(() => {
  _lastCapture = null;
  _overrideRedirect = null;
  _lastSelected = undefined;
  _releasesPayload = DEFAULT_RELEASES;
  _clock = 0;
  _resolverEpoch++;
});

describe('GET /updates/[channel]/[...path]', () => {
  test.each([
    ['stable', 'latest-mac.yml', 'stable', 'latest-mac.yml', 0, 'v0.89.18'],
    ['stable', 'OpenKnowledge-Setup-x64.exe', 'stable', 'latest.yml', 0, 'v0.89.18'],
    ['stable', 'OpenKnowledge-arm64.deb', 'stable', 'latest-linux-arm64.yml', 0, 'v0.89.18'],
    ['stable', 'OpenKnowledge-x86_64.rpm', 'stable', 'latest-linux.yml', 0, 'v0.89.18'],
    ['beta', 'beta-mac.yml', 'beta', 'beta-mac.yml', 0, 'v0.89.18-beta.1'],
    ['beta', 'OpenKnowledge-Setup-x64.exe', 'beta', 'beta.yml', 0, 'v0.89.18-beta.1'],
    ['beta', 'OpenKnowledge-arm64.deb', 'beta', 'beta-linux-arm64.yml', 0, 'v0.89.18-beta.1'],
    ['beta', 'OpenKnowledge-x86_64.rpm', 'beta', 'beta-linux.yml', 0, 'v0.89.18-beta.1'],
    [
      'beta-product',
      'OpenKnowledge-Beta-aarch64.rpm',
      'beta',
      'beta-product-linux-arm64.yml',
      0,
      'v0.89.18-beta.1',
    ],
    ['v1-stable', 'latest-mac.yml', 'stable', 'latest-mac.yml', 1, 'v1.0.0'],
    ['v1-stable', 'OpenKnowledge-Setup-x64.exe', 'stable', 'latest.yml', 1, 'v1.0.0'],
    ['v1-stable', 'OpenKnowledge-arm64.deb', 'stable', 'latest-linux-arm64.yml', 1, 'v1.0.0'],
    ['v1-beta', 'beta-mac.yml', 'beta', 'beta-mac.yml', 1, 'v1.0.0-beta.2'],
    ['v1-beta-product', 'beta-product-mac.yml', 'beta', 'beta-product-mac.yml', 1, 'v1.0.0-beta.2'],
  ] as const)(
    '%s/%s resolves %s manifest %s on major v%i → %s',
    async (channel, filename, kind, manifest, major, expectedTag) => {
      const res = await call(channel, [filename]);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${REL}/download/${expectedTag}/${filename}`);
      expect(_lastSelected).toEqual({ kind, assetName: manifest, major });
    },
  );

  test('v0 stable manifest resolves to v0.89.18 even when v1.0.0 is GitHub Latest, and is NOT counted', async () => {
    const res = await call('stable', ['latest-mac.yml']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/latest-mac.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('v0 beta and beta-product manifests resolve to v0.*-beta.*, NOT v1.*-beta.*', async () => {
    const beta = await call('beta', ['beta-mac.yml']);
    expect(beta.status).toBe(302);
    expect(beta.headers.get('location')).toBe(`${REL}/download/v0.89.18-beta.1/beta-mac.yml`);

    const betaProduct = await call('beta-product', ['beta-product-mac.yml']);
    expect(betaProduct.status).toBe(302);
    expect(betaProduct.headers.get('location')).toBe(
      `${REL}/download/v0.89.18-beta.1/beta-product-mac.yml`,
    );
    expect(_lastCapture).toBeNull();
  });

  test('v1-stable, v1-beta, and v1-beta-product resolve to v1 releases, NOT v0', async () => {
    const stable = await call('v1-stable', ['latest-mac.yml']);
    expect(stable.status).toBe(302);
    expect(stable.headers.get('location')).toBe(`${REL}/download/v1.0.0/latest-mac.yml`);

    const beta = await call('v1-beta', ['beta-mac.yml']);
    expect(beta.status).toBe(302);
    expect(beta.headers.get('location')).toBe(`${REL}/download/v1.0.0-beta.2/beta-mac.yml`);

    const betaProduct = await call('v1-beta-product', ['beta-product-mac.yml']);
    expect(betaProduct.status).toBe(302);
    expect(betaProduct.headers.get('location')).toBe(
      `${REL}/download/v1.0.0-beta.2/beta-product-mac.yml`,
    );
    expect(_lastCapture).toBeNull();
  });

  test('v1-stable returns cacheable 404 without console.error (never leaks v0) before any v1.* stable release exists', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      _releasesPayload = [
        makeRelease('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
        makeRelease('v1.0.0-beta.2', { prerelease: true, assetNames: ['beta-mac.yml'] }),
      ];
      const res = await call('v1-stable', ['latest-mac.yml']);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(_lastCapture).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('v1-stable returns 503 with no-store and logs console.error on a GitHub outage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      _overrideRedirect = {
        kind: 'fallback',
        url: REL,
        cause: 'GitHub releases API responded 502',
      };
      const res = await call('v1-stable', ['latest-mac.yml']);
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('stable zip 302s to the tagged v0 release and counts app_update_downloaded', async () => {
    const file = 'OpenKnowledge-0.89.18-arm64-mac.zip';
    const res = await call('stable', [file], { 'x-ok-from-version': '0.89.17' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/${file}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(_lastCapture?.event).toBe('app_update_downloaded');
    expect(_lastCapture?.properties?.channel).toBe('stable');
    expect(_lastCapture?.properties?.artifact_type).toBe('zip');
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18');
    expect(_lastCapture?.properties?.from_version).toBe('0.89.17');
    expect(_lastCapture?.properties?.ua_class).toBe('electron');
    expect(_lastCapture?.properties?.os).toBe('macos');
    expect(_lastCapture?.properties?.arch).toBe('arm64');
  });

  test('v1-stable and v1-beta-product versioned zips 302 and count telemetry', async () => {
    const stableFile = 'OpenKnowledge-1.0.0-arm64-mac.zip';
    const stableRes = await call('v1-stable', [stableFile], {
      'x-ok-from-version': '1.0.0-beta.2',
    });
    expect(stableRes.status).toBe(302);
    expect(stableRes.headers.get('location')).toBe(`${REL}/download/v1.0.0/${stableFile}`);
    expect(_lastCapture?.properties?.channel).toBe('v1-stable');
    expect(_lastCapture?.properties?.to_version).toBe('1.0.0');

    _lastCapture = null;
    const betaFile = 'OpenKnowledge-Beta-1.0.0-beta.2-arm64-mac.zip';
    const betaRes = await call('v1-beta-product', [betaFile]);
    expect(betaRes.status).toBe(302);
    expect(betaRes.headers.get('location')).toBe(`${REL}/download/v1.0.0-beta.2/${betaFile}`);
    expect(_lastCapture?.properties?.channel).toBe('v1-beta-product');
    expect(_lastCapture?.properties?.to_version).toBe('1.0.0-beta.2');
  });

  test('cross-major versioned artifacts are rejected with 404', async () => {
    expect((await call('stable', ['OpenKnowledge-1.0.0-arm64-mac.zip'])).status).toBe(404);
    expect((await call('v1-stable', ['OpenKnowledge-0.89.18-arm64-mac.zip'])).status).toBe(404);
    expect((await call('beta', ['OpenKnowledge-1.0.0-beta.2-arm64-mac.zip'])).status).toBe(404);
    expect((await call('v1-beta', ['OpenKnowledge-0.89.18-beta.1-arm64-mac.zip'])).status).toBe(
      404,
    );
    expect(
      (await call('beta-product', ['OpenKnowledge-Beta-1.0.0-beta.2-arm64-mac.zip'])).status,
    ).toBe(404);
    expect(
      (await call('v1-beta-product', ['OpenKnowledge-Beta-0.89.18-beta.1-arm64-mac.zip'])).status,
    ).toBe(404);
  });

  test('beta zip parses the prerelease version and counts (no from_version header)', async () => {
    const file = 'OpenKnowledge-0.20.0-beta.4-arm64-mac.zip';
    const res = await call('beta', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0-beta.4/${file}`);
    expect(_lastCapture?.properties?.to_version).toBe('0.20.0-beta.4');
    expect(_lastCapture?.properties?.from_version).toBeUndefined();
  });

  test('an ill-formed x-ok-from-version header is dropped, not forwarded to analytics', async () => {
    const file = 'OpenKnowledge-0.20.0-arm64-mac.zip';
    const res = await call('stable', [file], { 'x-ok-from-version': '../etc; rm -rf' });
    expect(res.status).toBe(302);
    expect(_lastCapture?.event).toBe('app_update_downloaded');
    expect(_lastCapture?.properties?.from_version).toBeUndefined();
  });

  test('blockmap 302s but is NOT counted', async () => {
    const file = 'OpenKnowledge-0.20.0-arm64-mac.zip.blockmap';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0/${file}`);
    expect(_lastCapture).toBeNull();
  });

  test('human dmg 302s to resolved v0 tag and is NOT counted', async () => {
    const res = await call('stable', ['OpenKnowledge-arm64.dmg']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/OpenKnowledge-arm64.dmg`);
    expect(_lastCapture).toBeNull();
  });

  test('dmg blockmap 302s to resolved v0 tag and is NOT counted', async () => {
    const file = 'OpenKnowledge-arm64.dmg.blockmap';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/${file}`);
    expect(_lastCapture).toBeNull();
  });

  test('invalid channel → 404', async () => {
    expect((await call('canary', ['latest-mac.yml'])).status).toBe(404);
  });

  test('public channel paths reject the other product manifest or artifact', async () => {
    expect((await call('stable', ['beta-mac.yml'])).status).toBe(404);
    expect((await call('v1-stable', ['beta-mac.yml'])).status).toBe(404);
    expect((await call('beta', ['latest-mac.yml'])).status).toBe(404);
    expect((await call('v1-beta', ['latest-mac.yml'])).status).toBe(404);
    expect((await call('stable', ['OpenKnowledge-Beta-0.21.0-beta.4-arm64-mac.zip'])).status).toBe(
      404,
    );
    expect((await call('beta', ['OpenKnowledge-0.21.0-arm64-mac.zip'])).status).toBe(404);
    expect((await call('beta', ['OpenKnowledge-Beta-0.21.0-beta.4-arm64-mac.zip'])).status).toBe(
      404,
    );
    expect((await call('beta', ['beta-product-mac.yml'])).status).toBe(404);
    expect((await call('beta-product', ['beta-mac.yml'])).status).toBe(404);
    expect((await call('beta-product', ['OpenKnowledge-0.21.0-beta.4-arm64-mac.zip'])).status).toBe(
      404,
    );
    expect((await call('v1-beta-product', ['beta-mac.yml'])).status).toBe(404);
    expect(
      (await call('v1-beta-product', ['OpenKnowledge-1.0.0-beta.2-arm64-mac.zip'])).status,
    ).toBe(404);
  });

  test('separate Beta uses its own manifest and artifact names', async () => {
    const manifest = await call('beta-product', ['beta-product-mac.yml']);
    expect(manifest.headers.get('location')).toBe(
      `${REL}/download/v0.89.18-beta.1/beta-product-mac.yml`,
    );
    const file = 'OpenKnowledge-Beta-0.89.18-beta.1-arm64-mac.zip';
    expect((await call('beta-product', [file])).headers.get('location')).toBe(
      `${REL}/download/v0.89.18-beta.1/${file}`,
    );
  });

  test('path traversal / multi-segment → 404', async () => {
    expect((await call('stable', ['..', 'secret'])).status).toBe(404);
  });

  test('unknown artifact type → 404', async () => {
    expect((await call('stable', ['random.txt'])).status).toBe(404);
  });

  test('x64 zip parses the version and counts', async () => {
    const file = 'OpenKnowledge-0.20.0-x64-mac.zip';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.20.0/${file}`);
    expect(_lastCapture?.properties?.to_version).toBe('0.20.0');
  });

  test('v0 channels serve their pinned v0 floor tag (302 no-store) on resolver fallback instead of 503', async () => {
    _overrideRedirect = { kind: 'fallback', url: REL, cause: 'API error' };
    const stableRes = await call('stable', ['latest-mac.yml']);
    expect(stableRes.status).toBe(302);
    expect(stableRes.headers.get('location')).toBe(`${REL}/download/v0.89.17/latest-mac.yml`);
    expect(stableRes.headers.get('cache-control')).toBe('no-store');

    const betaRes = await call('beta', ['beta-mac.yml']);
    expect(betaRes.status).toBe(302);
    expect(betaRes.headers.get('location')).toBe(`${REL}/download/v0.89.17-beta.0/beta-mac.yml`);
    expect(betaRes.headers.get('cache-control')).toBe('no-store');

    const betaProductRes = await call('beta-product', ['beta-product-mac.yml']);
    expect(betaProductRes.status).toBe(302);
    expect(betaProductRes.headers.get('location')).toBe(
      `${REL}/download/v0.89.17-beta.0/beta-product-mac.yml`,
    );
    expect(betaProductRes.headers.get('cache-control')).toBe('no-store');
    expect(_lastCapture).toBeNull();
  });

  test('v1 channels 503 (no-store) on resolver fallback, not counted', async () => {
    _overrideRedirect = { kind: 'fallback', url: REL, cause: 'API error' };
    for (const [channel, manifest] of [
      ['v1-stable', 'latest-mac.yml'],
      ['v1-beta', 'beta-mac.yml'],
      ['v1-beta-product', 'beta-product-mac.yml'],
    ] as const) {
      const res = await call(channel, [manifest]);
      expect(res.status, channel).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(_lastCapture).toBeNull();
  });

  test('stale-lkg resolver still 302s (graceful degradation during a GitHub outage)', async () => {
    _overrideRedirect = {
      kind: 'stale-lkg',
      url: `${REL}/download/v0.89.18/latest-mac.yml`,
      refreshError: 'API timeout',
    };
    const res = await call('stable', ['latest-mac.yml']);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/latest-mac.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('Windows stable and beta manifests 302 to resolved v0 tags, NOT counted', async () => {
    const stable = await call('stable', ['latest.yml']);
    expect(stable.status).toBe(302);
    expect(stable.headers.get('location')).toBe(`${REL}/download/v0.89.18/latest.yml`);

    const beta = await call('beta', ['beta.yml']);
    expect(beta.status).toBe(302);
    expect(beta.headers.get('location')).toBe(`${REL}/download/v0.89.18-beta.1/beta.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('Linux manifests (x64 + arm64-suffixed) 302 to resolved tags and are NOT counted', async () => {
    const stable = await call('stable', ['latest-linux-arm64.yml']);
    expect(stable.status).toBe(302);
    expect(stable.headers.get('location')).toBe(`${REL}/download/v0.89.18/latest-linux-arm64.yml`);

    const beta = await call('beta', ['beta-linux.yml']);
    expect(beta.status).toBe(302);
    expect(beta.headers.get('location')).toBe(`${REL}/download/v0.89.18-beta.1/beta-linux.yml`);

    const v1Stable = await call('v1-stable', ['latest-linux-arm64.yml']);
    expect(v1Stable.status).toBe(302);
    expect(v1Stable.headers.get('location')).toBe(`${REL}/download/v1.0.0/latest-linux-arm64.yml`);
    expect(_lastCapture).toBeNull();
  });

  test('Windows stable exe counts with artifact_type=exe and server-derived to_version', async () => {
    const file = 'OpenKnowledge-Setup-x64.exe';
    const res = await call('stable', [file], { 'x-ok-from-version': '0.89.17' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/${file}`);
    expect(_lastCapture?.event).toBe('app_update_downloaded');
    expect(_lastCapture?.properties?.artifact_type).toBe('exe');
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18');
    expect(_lastCapture?.properties?.from_version).toBe('0.89.17');
    expect(_lastCapture?.properties?.os).toBe('windows');
    expect(_lastCapture?.properties?.arch).toBe('x64');
  });

  test('server-derived versions always ignore client-supplied x-ok-to-version headers', async () => {
    await call('stable', ['OpenKnowledge-0.89.18-arm64-mac.zip'], {
      'x-ok-to-version': '9.9.9',
    });
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18');

    _lastCapture = null;
    await call('stable', ['OpenKnowledge-Setup-x64.exe'], { 'x-ok-to-version': '9.9.9' });
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18');

    _lastCapture = null;
    await call('beta', ['OpenKnowledge-arm64.deb'], { 'x-ok-to-version': '9.9.9' });
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18-beta.1');
  });

  test('Linux beta deb counts with to_version derived from the resolved beta tag', async () => {
    const file = 'OpenKnowledge-arm64.deb';
    const res = await call('beta', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18-beta.1/${file}`);
    expect(_lastCapture?.event).toBe('app_update_downloaded');
    expect(_lastCapture?.properties?.artifact_type).toBe('deb');
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18-beta.1');
    expect(_lastCapture?.properties?.os).toBe('linux');
    expect(_lastCapture?.properties?.arch).toBe('arm64');
  });

  test('Linux stable rpm counts with artifact_type=rpm and server-derived to_version', async () => {
    const file = 'OpenKnowledge-x86_64.rpm';
    const res = await call('stable', [file]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${REL}/download/v0.89.18/${file}`);
    expect(_lastCapture?.properties?.artifact_type).toBe('rpm');
    expect(_lastCapture?.properties?.to_version).toBe('0.89.18');
    expect(_lastCapture?.properties?.os).toBe('linux');
    expect(_lastCapture?.properties?.arch).toBe('x64');
  });

  test('every packager arch spelling normalizes onto one analytics vocabulary', async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['OpenKnowledge-Setup-arm64.exe', 'windows', 'arm64'],
      ['OpenKnowledge-amd64.deb', 'linux', 'x64'],
      ['OpenKnowledge-aarch64.rpm', 'linux', 'arm64'],
      ['OpenKnowledge-0.20.0-universal-mac.zip', 'macos', 'universal'],
    ];
    for (const [file, os, arch] of cases) {
      _lastCapture = null;
      const res = await call('stable', [file]);
      expect(res.status).toBe(302);
      expect(_lastCapture?.properties?.os, file).toBe(os);
      expect(_lastCapture?.properties?.arch, file).toBe(arch);
    }
  });

  test('an unrecognized arch token is dropped, not forwarded to analytics', async () => {
    const res = await call('stable', ['OpenKnowledge-riscv64.deb']);
    expect(res.status).toBe(302);
    expect(_lastCapture?.properties?.os).toBe('linux');
    expect(_lastCapture?.properties?.arch).toBeUndefined();
  });

  test('a manifest-lookalike name that is not a real channel file → 404', async () => {
    expect((await call('stable', ['nightly-mac.yml'])).status).toBe(404);
    expect((await call('stable', ['latest-windows.yml'])).status).toBe(404);
    expect((await call('stable', ['builder-debug.yml'])).status).toBe(404);
  });
});
