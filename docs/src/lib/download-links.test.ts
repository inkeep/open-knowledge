import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BETA_DMG_ASSET_NAME,
  betaChannel,
  CLOUD_CHANNEL,
  CLOUD_DMG_ASSET_NAME,
  CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
  CLOUD_LINUX_DEB_X64_ASSET_NAME,
  CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
  CLOUD_LINUX_RPM_X64_ASSET_NAME,
  CLOUD_RELEASES_PAGE_URL,
  cloudTargetById,
  createBetaResolver,
  createCloudAssetsResolver,
  createReleasesPageCache,
  createStableResolver,
  DMG_ASSET_NAME,
  FALLBACK_CACHE_CONTROL,
  MAX_RELEASE_PAGES,
  pickLatestReleaseAssetUrl,
  RELEASES_PAGE_URL,
  resolveCloudTargetFromParams,
  STABLE_DMG_URL,
  SUCCESS_CACHE_CONTROL,
  stableChannel,
  toRedirectResponse,
} from './download-links.ts';

function release(
  tag: string,
  opts: { draft?: boolean; prerelease?: boolean; assetNames?: string[]; assetHost?: string } = {},
) {
  const {
    draft = false,
    prerelease = true,
    assetNames = [BETA_DMG_ASSET_NAME],
    assetHost = 'https://github.com/inkeep/open-knowledge/releases/download',
  } = opts;
  return {
    tag_name: tag,
    draft,
    prerelease,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `${assetHost}/${tag}/${name}`,
    })),
  };
}

function dmgUrl(tag: string, assetName = BETA_DMG_ASSET_NAME) {
  return `https://github.com/inkeep/open-knowledge/releases/download/${tag}/${assetName}`;
}

function pickLatestBeta(payload: unknown) {
  return pickLatestReleaseAssetUrl(payload, betaChannel());
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function cloudRelease(counter: number) {
  return release(`v0.89.13-cloud.${counter}`, { assetNames: [CLOUD_DMG_ASSET_NAME] });
}

function fullPageOfCloudReleases(page: number) {
  return Array.from({ length: 100 }, (_, i) => cloudRelease(20_000 - page * 100 - i));
}

function pagedReleases(pages: Record<number, unknown>, requestedPages: number[] = []) {
  return async (input: RequestInfo | URL) => {
    const page = Number(new URL(String(input)).searchParams.get('page'));
    requestedPages.push(page);
    const body = pages[page] ?? [];
    return body instanceof Response ? body : jsonResponse(body);
  };
}

describe('pickLatestReleaseAssetUrl for the beta channel', () => {
  test('keeps a platform on its latest available release when a newer release omits it', () => {
    const releases = [
      release('v0.78.0-beta.7', { assetNames: ['beta-mac.yml', DMG_ASSET_NAME] }),
      release('v0.78.0-beta.6', { assetNames: ['beta.yml', 'beta-linux-arm64.yml'] }),
    ];
    expect(pickLatestReleaseAssetUrl(releases, betaChannel('beta.yml'))).toBe(
      dmgUrl('v0.78.0-beta.6', 'beta.yml'),
    );
    expect(pickLatestReleaseAssetUrl(releases, betaChannel('beta-linux-arm64.yml'))).toBe(
      dmgUrl('v0.78.0-beta.6', 'beta-linux-arm64.yml'),
    );
    expect(pickLatestReleaseAssetUrl(releases, betaChannel('beta-mac.yml'))).toBe(
      dmgUrl('v0.78.0-beta.7', 'beta-mac.yml'),
    );
  });

  test('resolves legacy and separate Beta independently from the same release list', () => {
    const releases = [
      release('v0.78.0-beta.6', { assetNames: [DMG_ASSET_NAME, BETA_DMG_ASSET_NAME] }),
      release('v0.78.0-beta.7', { assetNames: [BETA_DMG_ASSET_NAME] }),
    ];
    expect(pickLatestReleaseAssetUrl(releases, betaChannel(DMG_ASSET_NAME))).toBe(
      dmgUrl('v0.78.0-beta.6', DMG_ASSET_NAME),
    );
    expect(pickLatestReleaseAssetUrl(releases, betaChannel())).toBe(dmgUrl('v0.78.0-beta.7'));
  });

  test('picks the highest-versioned published beta', () => {
    const url = pickLatestBeta([
      release('v0.12.0-beta.7'),
      release('v0.12.0-beta.6'),
      release('v0.11.0', { prerelease: false }),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.7'));
  });

  test('ranks by version, not the array order GitHub returns (older beta listed first)', () => {
    const url = pickLatestBeta([
      release('v0.20.0-beta.9'),
      release('v0.20.0-beta.8'),
      release('v0.20.0-beta.13'),
      release('v0.20.0-beta.12'),
      release('v0.20.0-beta.10'),
    ]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.13'));
  });

  test('beta.10 outranks beta.9 (no lexical tag compare)', () => {
    const url = pickLatestBeta([release('v0.20.0-beta.9'), release('v0.20.0-beta.10')]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.10'));
  });

  test('ranks across base versions (minor/patch), not just the beta counter', () => {
    const url = pickLatestBeta([
      release('v0.20.0-beta.99'),
      release('v0.21.0-beta.1'),
      release('v0.20.1-beta.2'),
    ]);
    expect(url).toBe(dmgUrl('v0.21.0-beta.1'));
  });

  test('skips the newest beta when its DMG is missing, ranking the next-newest', () => {
    const url = pickLatestBeta([
      release('v0.20.0-beta.13', { assetNames: ['beta-mac.yml'] }),
      release('v0.20.0-beta.12'),
      release('v0.20.0-beta.9'),
    ]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.12'));
  });

  test('skips stable releases even when they appear first', () => {
    const url = pickLatestBeta([
      release('v0.11.0', { prerelease: false }),
      release('v0.11.0-beta.3'),
    ]);
    expect(url).toBe(dmgUrl('v0.11.0-beta.3'));
  });

  test('skips a beta whose DMG never uploaded and falls back to the previous one', () => {
    const url = pickLatestBeta([
      release('v0.12.0-beta.7', { assetNames: ['beta-mac.yml'] }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('skips drafts', () => {
    const url = pickLatestBeta([
      release('v0.12.0-beta.7', { draft: true }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('skips prereleases that are not -beta.N tags', () => {
    const url = pickLatestBeta([
      release('v0.12.0-rc.1'),
      release('beta-latest'),
      release('v0.12.0-beta'),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('skips legacy shared-identity beta artifacts', () => {
    const url = pickLatestBeta([
      release('v0.12.0-beta.8', { assetNames: [DMG_ASSET_NAME] }),
      release('v0.12.0-beta.7'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.7'));
  });

  test('rejects asset URLs outside our release-download prefix', () => {
    const url = pickLatestBeta([
      release('v0.12.0-beta.7', { assetHost: 'https://evil.example.com/releases/download' }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('returns null when no published beta carries the DMG', () => {
    expect(pickLatestBeta([release('v0.11.0', { prerelease: false })])).toBeNull();
    expect(pickLatestBeta([])).toBeNull();
  });

  test('returns null on malformed payloads instead of throwing', () => {
    expect(pickLatestBeta(null)).toBeNull();
    expect(pickLatestBeta({ message: 'API rate limit exceeded' })).toBeNull();
    expect(pickLatestBeta([{ tag_name: 42 }])).toBeNull();
  });
});

describe('createBetaResolver', () => {
  test('resolves fresh, then serves from LKG without refetching inside the TTL', async () => {
    let clock = 0;
    let calls = 0;
    const resolve = createBetaResolver({
      fetchImpl: async () => {
        calls++;
        return jsonResponse([release('v0.12.0-beta.7')]);
      },
      now: () => clock,
    });

    expect(await resolve()).toEqual({ kind: 'fresh', url: dmgUrl('v0.12.0-beta.7') });
    clock = 299_000;
    expect(await resolve()).toEqual({ kind: 'cached', url: dmgUrl('v0.12.0-beta.7') });
    expect(calls).toBe(1);
  });

  test('refetches after the TTL and picks up a newer beta', async () => {
    let clock = 0;
    const payloads = [[release('v0.12.0-beta.7')], [release('v0.12.0-beta.8')]];
    let calls = 0;
    const resolve = createBetaResolver({
      fetchImpl: async () => jsonResponse(payloads[calls++]),
      now: () => clock,
    });

    expect(await resolve()).toEqual({ kind: 'fresh', url: dmgUrl('v0.12.0-beta.7') });
    clock = 300_000;
    expect(await resolve()).toEqual({ kind: 'fresh', url: dmgUrl('v0.12.0-beta.8') });
    expect(calls).toBe(2);
  });

  test('serves the stale LKG when the refresh fails', async () => {
    let clock = 0;
    let calls = 0;
    const resolve = createBetaResolver({
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse([release('v0.12.0-beta.7')]);
        throw new Error('network down');
      },
      now: () => clock,
    });

    await resolve();
    clock = 10_000_000;
    const result = await resolve();
    expect(result.kind).toBe('stale-lkg');
    expect(result.url).toBe(dmgUrl('v0.12.0-beta.7'));
    if (result.kind === 'stale-lkg') {
      expect(result.refreshError).toBe('network down');
    }
  });

  test('falls back to the releases page when the API errors and no LKG exists', async () => {
    const resolve = createBetaResolver({
      fetchImpl: async () => jsonResponse({ message: 'rate limited' }, 403),
      now: () => 0,
    });
    const result = await resolve();
    expect(result.kind).toBe('fallback');
    expect(result.url).toBe(RELEASES_PAGE_URL);
    if (result.kind === 'fallback') {
      expect(result.cause).toContain('403');
    }
  });

  test('falls back when the API succeeds but no qualifying beta exists', async () => {
    const resolve = createBetaResolver({
      fetchImpl: async () => jsonResponse([release('v0.11.0', { prerelease: false })]),
      now: () => 0,
    });
    const result = await resolve();
    expect(result.kind).toBe('fallback');
    expect(result.url).toBe(RELEASES_PAGE_URL);
  });

  test('falls back when fetch itself rejects and no LKG exists', async () => {
    const resolve = createBetaResolver({
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
      now: () => 0,
    });
    const result = await resolve();
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.cause).toBe('ECONNRESET');
    }
  });
});

describe('beta resolution behind a flood of Cloud prereleases', () => {
  test('finds the newest beta on a later page when a full page of Cloud prereleases precedes it', async () => {
    const resolve = createBetaResolver({
      fetchImpl: pagedReleases({
        1: fullPageOfCloudReleases(1),
        2: [release('v0.89.13-beta.1'), release('v0.89.12', { prerelease: false })],
      }),
      now: () => 0,
    });
    expect(await resolve()).toEqual({ kind: 'fresh', url: dmgUrl('v0.89.13-beta.1') });
  });

  test('a beta update manifest resolves past the Cloud prereleases too', async () => {
    const resolve = createBetaResolver({
      assetName: 'beta-mac.yml',
      fetchImpl: pagedReleases({
        1: fullPageOfCloudReleases(1),
        2: fullPageOfCloudReleases(2),
        3: [release('v0.89.13-beta.1', { assetNames: ['beta-mac.yml'] })],
      }),
      now: () => 0,
    });
    expect(await resolve()).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.13-beta.1', 'beta-mac.yml'),
    });
  });

  test('gives up after a bounded number of pages and falls back to the releases page', async () => {
    const requestedPages: number[] = [];
    const pages = Object.fromEntries(
      Array.from({ length: MAX_RELEASE_PAGES + 1 }, (_, i) => [
        i + 1,
        fullPageOfCloudReleases(i + 1),
      ]),
    );
    pages[MAX_RELEASE_PAGES + 1] = [release('v0.89.13-beta.1')];
    const resolve = createBetaResolver({
      fetchImpl: pagedReleases(pages, requestedPages),
      now: () => 0,
    });
    const result = await resolve();
    expect(result.kind).toBe('fallback');
    expect(result.url).toBe(RELEASES_PAGE_URL);
    expect(requestedPages).toEqual(Array.from({ length: MAX_RELEASE_PAGES }, (_, i) => i + 1));
  });

  test('a failed later page falls back with its status rather than reporting no beta', async () => {
    const resolve = createBetaResolver({
      fetchImpl: pagedReleases({
        1: fullPageOfCloudReleases(1),
        2: jsonResponse({ message: 'rate limited' }, 403),
      }),
      now: () => 0,
    });
    const result = await resolve();
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.cause).toContain('403');
    }
  });
});

describe('resolver upstream budget', () => {
  test('a walk that finds nothing is not repeated until the TTL passes, then picks up a new release', async () => {
    let clock = 0;
    const requestedPages: number[] = [];
    const pages: Record<number, unknown> = Object.fromEntries(
      Array.from({ length: MAX_RELEASE_PAGES }, (_, i) => [
        i + 1,
        Array.from({ length: 100 }, (_, j) => release(`v0.89.${i}-beta.${j}`)),
      ]),
    );
    const resolve = createCloudAssetsResolver({
      fetchImpl: pagedReleases(pages, requestedPages),
      now: () => clock,
    });

    expect((await resolve('macos-arm64')).kind).toBe('fallback');
    expect(requestedPages).toHaveLength(MAX_RELEASE_PAGES);
    clock = 299_000;
    const repeated = await resolve('macos-arm64');
    expect(repeated.kind).toBe('fallback');
    expect(requestedPages).toHaveLength(MAX_RELEASE_PAGES);

    pages[1] = [cloudRelease(17243)];
    clock = 300_000;
    expect(await resolve('macos-arm64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.13-cloud.17243', CLOUD_DMG_ASSET_NAME),
    });
  });

  test('a failed refresh keeps serving the stale LKG without refetching until the TTL passes', async () => {
    let clock = 0;
    let calls = 0;
    const resolve = createBetaResolver({
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse([release('v0.12.0-beta.7')]);
        return jsonResponse({ message: 'rate limited' }, 403);
      },
      now: () => clock,
    });

    await resolve();
    clock = 300_000;
    expect((await resolve()).kind).toBe('stale-lkg');
    clock = 599_000;
    const repeated = await resolve();
    expect(repeated).toEqual({
      kind: 'stale-lkg',
      url: dmgUrl('v0.12.0-beta.7'),
      refreshError: 'GitHub releases API responded 403',
    });
    expect(calls).toBe(2);
  });

  test('concurrent requests share one refresh', async () => {
    const pending: ((response: Response) => void)[] = [];
    const resolve = createBetaResolver({
      fetchImpl: () =>
        new Promise<Response>((settle) => {
          pending.push(settle);
        }),
      now: () => 0,
    });

    const first = resolve();
    const second = resolve();
    expect(pending.length).toBeGreaterThan(0);
    for (const settle of pending) settle(jsonResponse([release('v0.12.0-beta.7')]));
    const expected = { kind: 'fresh', url: dmgUrl('v0.12.0-beta.7') };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(pending).toHaveLength(1);
  });
});

describe('Cloud prerelease resolution', () => {
  test('picks the newest Cloud prerelease carrying the Cloud DMG and ignores betas, stables and drafts', () => {
    const url = pickLatestReleaseAssetUrl(
      [
        release('v0.89.14-beta.0', { assetNames: [BETA_DMG_ASSET_NAME, CLOUD_DMG_ASSET_NAME] }),
        release('v0.89.14', { prerelease: false, assetNames: [CLOUD_DMG_ASSET_NAME] }),
        release('v0.89.13-cloud.17252', { draft: true, assetNames: [CLOUD_DMG_ASSET_NAME] }),
        release('v0.89.13-cloud.17251', { assetNames: ['cloud-mac.yml'] }),
        cloudRelease(17243),
        cloudRelease(17250),
      ],
      CLOUD_CHANNEL,
    );
    expect(url).toBe(dmgUrl('v0.89.13-cloud.17250', CLOUD_DMG_ASSET_NAME));
  });

  test('ranks Cloud prereleases by version, not by counter alone', () => {
    const url = pickLatestReleaseAssetUrl(
      [cloudRelease(17299), release('v0.90.0-cloud.17260', { assetNames: [CLOUD_DMG_ASSET_NAME] })],
      CLOUD_CHANNEL,
    );
    expect(url).toBe(dmgUrl('v0.90.0-cloud.17260', CLOUD_DMG_ASSET_NAME));
  });

  test('the beta channel never serves a Cloud prerelease', () => {
    expect(
      pickLatestReleaseAssetUrl(
        [release('v0.89.13-cloud.17250', { assetNames: [BETA_DMG_ASSET_NAME] })],
        betaChannel(),
      ),
    ).toBeNull();
  });
});

describe('toRedirectResponse', () => {
  test('success kinds redirect with the CDN-cacheable header', () => {
    for (const kind of ['fresh', 'cached'] as const) {
      const res = toRedirectResponse({ kind, url: dmgUrl('v0.12.0-beta.7') });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(dmgUrl('v0.12.0-beta.7'));
      expect(res.headers.get('cache-control')).toBe(SUCCESS_CACHE_CONTROL);
    }
  });

  test('stale-lkg kind redirects with the CDN-cacheable header', () => {
    const res = toRedirectResponse({
      kind: 'stale-lkg',
      url: dmgUrl('v0.12.0-beta.7'),
      refreshError: 'network down',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(dmgUrl('v0.12.0-beta.7'));
    expect(res.headers.get('cache-control')).toBe(SUCCESS_CACHE_CONTROL);
  });

  test('fallback redirects to the releases page uncached', () => {
    const res = toRedirectResponse({
      kind: 'fallback',
      url: RELEASES_PAGE_URL,
      cause: 'GitHub releases API responded 502',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(RELEASES_PAGE_URL);
    expect(res.headers.get('cache-control')).toBe(FALLBACK_CACHE_CONTROL);
  });
});

describe('createCloudAssetsResolver', () => {
  test('resolves all five Cloud desktop installers from a single GitHub releases fetch and caches them', async () => {
    let clock = 0;
    const requestedPages: number[] = [];
    const resolve = createCloudAssetsResolver({
      fetchImpl: pagedReleases(
        {
          1: [
            release('v0.89.16-cloud.19223', {
              assetNames: [
                CLOUD_DMG_ASSET_NAME,
                CLOUD_LINUX_DEB_X64_ASSET_NAME,
                CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
                CLOUD_LINUX_RPM_X64_ASSET_NAME,
                CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
              ],
            }),
          ],
        },
        requestedPages,
      ),
      now: () => clock,
    });

    expect(await resolve('macos-arm64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_DMG_ASSET_NAME),
    });
    clock = 10_000;
    expect(await resolve('linux-deb-x64')).toEqual({
      kind: 'cached',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
    });
    expect(await resolve('linux-deb-arm64')).toEqual({
      kind: 'cached',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_ARM64_ASSET_NAME),
    });
    expect(await resolve('linux-rpm-x64')).toEqual({
      kind: 'cached',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_RPM_X64_ASSET_NAME),
    });
    expect(await resolve('linux-rpm-arm64')).toEqual({
      kind: 'cached',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_RPM_ARM64_ASSET_NAME),
    });
    expect(requestedPages).toEqual([1]);
  });

  test('keeps an older Cloud release for an installer omitted from the newest release', async () => {
    const resolve = createCloudAssetsResolver({
      fetchImpl: pagedReleases({
        1: [
          release('v0.89.16-cloud.19224', { assetNames: [CLOUD_DMG_ASSET_NAME] }),
          release('v0.89.16-cloud.19223', {
            assetNames: [CLOUD_DMG_ASSET_NAME, CLOUD_LINUX_DEB_X64_ASSET_NAME],
          }),
        ],
      }),
      now: () => 0,
    });

    expect(await resolve('macos-arm64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19224', CLOUD_DMG_ASSET_NAME),
    });
    expect(await resolve('linux-deb-x64')).toEqual({
      kind: 'cached',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
    });
    const missing = await resolve('linux-rpm-arm64');
    expect(missing.kind).toBe('fallback');
    expect(missing.url).toBe(CLOUD_RELEASES_PAGE_URL);
  });

  test('serves stale-lkg when refresh fails after TTL expiry and remembers the miss inside the negative-cache window', async () => {
    let clock = 0;
    let calls = 0;
    let fail = false;
    const resolve = createCloudAssetsResolver({
      fetchImpl: async () => {
        calls++;
        if (fail) throw new Error('github 502');
        return jsonResponse([
          release('v0.89.16-cloud.19223', {
            assetNames: [
              CLOUD_DMG_ASSET_NAME,
              CLOUD_LINUX_DEB_X64_ASSET_NAME,
              CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
              CLOUD_LINUX_RPM_X64_ASSET_NAME,
              CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
            ],
          }),
        ]);
      },
      now: () => clock,
    });

    const dmg = dmgUrl('v0.89.16-cloud.19223', CLOUD_DMG_ASSET_NAME);
    expect(await resolve('macos-arm64')).toEqual({ kind: 'fresh', url: dmg });
    expect(calls).toBe(1);

    fail = true;
    clock = 300_000;
    expect(await resolve('macos-arm64')).toEqual({
      kind: 'stale-lkg',
      url: dmg,
      refreshError: 'github 502',
    });
    expect(calls).toBe(2);

    clock = 400_000;
    expect(await resolve('macos-arm64')).toEqual({
      kind: 'stale-lkg',
      url: dmg,
      refreshError: 'github 502',
    });
    expect(calls).toBe(2);

    fail = false;
    clock = 600_000;
    expect(await resolve('macos-arm64')).toEqual({ kind: 'fresh', url: dmg });
    expect(calls).toBe(3);
  });

  test('falls back and negative-caches when no Cloud release is published or fetch fails cold', async () => {
    let clock = 0;
    let calls = 0;
    const resolve = createCloudAssetsResolver({
      fetchImpl: async () => {
        calls++;
        return jsonResponse([
          release('v0.89.16-beta.0'),
          release('v0.89.15', { prerelease: false }),
        ]);
      },
      now: () => clock,
    });

    const first = await resolve('macos-arm64');
    expect(first.kind).toBe('fallback');
    expect(first.url).toBe(CLOUD_RELEASES_PAGE_URL);
    expect(calls).toBe(1);

    clock = 120_000;
    const second = await resolve('linux-deb-x64');
    expect(second.kind).toBe('fallback');
    expect(second.url).toBe(CLOUD_RELEASES_PAGE_URL);
    expect(calls).toBe(1);

    clock = 300_000;
    await resolve('macos-arm64');
    expect(calls).toBe(2);
  });

  test('shares a single in-flight GitHub fetch across concurrent callers', async () => {
    let calls = 0;
    const gate = Promise.withResolvers<void>();
    const resolve = createCloudAssetsResolver({
      fetchImpl: async () => {
        calls++;
        await gate.promise;
        return jsonResponse([
          release('v0.89.16-cloud.19223', {
            assetNames: [
              CLOUD_DMG_ASSET_NAME,
              CLOUD_LINUX_DEB_X64_ASSET_NAME,
              CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
              CLOUD_LINUX_RPM_X64_ASSET_NAME,
              CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
            ],
          }),
        ]);
      },
      now: () => 0,
    });

    const p1 = resolve('macos-arm64');
    const p2 = resolve('linux-deb-x64');
    expect(calls).toBe(1);
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_DMG_ASSET_NAME),
    });
    expect(r2).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
    });
    expect(calls).toBe(1);
  });

  test('keeps page-1 targets servable if a later page throws while hunting for missing assets', async () => {
    const requestedPages: number[] = [];
    const page1 = [
      release('v0.89.16-cloud.19223', { assetNames: [CLOUD_DMG_ASSET_NAME] }),
      ...Array.from({ length: 99 }, (_, i) => release(`v0.89.15-beta.${i}`)),
    ];
    const resolve = createCloudAssetsResolver({
      fetchImpl: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        requestedPages.push(page);
        if (page === 1) return jsonResponse(page1);
        return new Response('rate limited', { status: 403 });
      },
      now: () => 0,
    });

    expect(await resolve('macos-arm64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_DMG_ASSET_NAME),
    });
    expect(requestedPages).toEqual([1, 2]);
    const linuxFallback = await resolve('linux-deb-x64');
    expect(linuxFallback.kind).toBe('fallback');
    if (linuxFallback.kind === 'fallback') {
      expect(linuxFallback.cause).toMatch(/403/);
    }
  });

  test('preserves warm LKG targets as stale-lkg when a later-page failure ends a refresh early', async () => {
    let clock = 0;
    let failPage2 = false;
    const warmPage1 = [
      release('v0.89.16-cloud.19223', {
        assetNames: [
          CLOUD_DMG_ASSET_NAME,
          CLOUD_LINUX_DEB_X64_ASSET_NAME,
          CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
          CLOUD_LINUX_RPM_X64_ASSET_NAME,
          CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
        ],
      }),
    ];
    const partialPage1 = [
      release('v0.89.17-cloud.20000', { assetNames: [CLOUD_DMG_ASSET_NAME] }),
      ...Array.from({ length: 99 }, (_, i) => release(`v0.89.16-beta.${i}`)),
    ];
    const resolve = createCloudAssetsResolver({
      fetchImpl: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get('page'));
        if (!failPage2) return jsonResponse(warmPage1);
        if (page === 1) return jsonResponse(partialPage1);
        return new Response('rate limited', { status: 403 });
      },
      now: () => clock,
    });

    expect(await resolve('linux-deb-x64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
    });

    clock = 6 * 60 * 1000;
    failPage2 = true;

    const refreshedMac = await resolve('macos-arm64');
    expect(refreshedMac).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.17-cloud.20000', CLOUD_DMG_ASSET_NAME),
    });

    const preservedLinux = await resolve('linux-deb-x64');
    expect(preservedLinux.kind).toBe('stale-lkg');
    if (preservedLinux.kind === 'stale-lkg') {
      expect(preservedLinux.url).toBe(
        dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
      );
      expect(preservedLinux.refreshError).toMatch(/403/);
    }

    clock = 12 * 60 * 1000;
    failPage2 = false;
    expect(await resolve('linux-deb-x64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_DEB_X64_ASSET_NAME),
    });
  });

  test('walks subsequent pages to find Cloud releases past a full page of non-Cloud releases', async () => {
    const requestedPages: number[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => release(`v0.89.15-beta.${i}`));
    const page2 = [
      release('v0.89.16-cloud.19223', {
        assetNames: [
          CLOUD_DMG_ASSET_NAME,
          CLOUD_LINUX_DEB_X64_ASSET_NAME,
          CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
          CLOUD_LINUX_RPM_X64_ASSET_NAME,
          CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
        ],
      }),
    ];
    const resolve = createCloudAssetsResolver({
      fetchImpl: pagedReleases({ 1: page1, 2: page2 }, requestedPages),
      now: () => 0,
    });

    expect(await resolve('linux-rpm-x64')).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.16-cloud.19223', CLOUD_LINUX_RPM_X64_ASSET_NAME),
    });
    expect(requestedPages).toEqual([1, 2]);
  });
});

describe('cloudTargetById', () => {
  test('returns the catalog entry for macos-arm64', () => {
    expect(cloudTargetById('macos-arm64')).toMatchObject({
      id: 'macos-arm64',
      os: 'macos',
      arch: 'arm64',
      format: 'dmg',
      assetName: CLOUD_DMG_ASSET_NAME,
    });
  });
});

describe('resolveCloudTargetFromParams', () => {
  test('matches every supported Cloud os/arch/format triple and rejects unsupported ones', () => {
    expect(
      resolveCloudTargetFromParams(new URLSearchParams('os=macos&arch=arm64&format=dmg'))?.id,
    ).toBe('macos-arm64');
    expect(
      resolveCloudTargetFromParams(new URLSearchParams('os=linux&arch=x64&format=deb'))?.id,
    ).toBe('linux-deb-x64');
    expect(
      resolveCloudTargetFromParams(new URLSearchParams('os=linux&arch=arm64&format=rpm'))?.id,
    ).toBe('linux-rpm-arm64');
    expect(
      resolveCloudTargetFromParams(new URLSearchParams('os=windows&arch=x64&format=exe')),
    ).toBeNull();
    expect(resolveCloudTargetFromParams(new URLSearchParams(''))).toBeNull();
  });
});

describe('STABLE_DMG_URL', () => {
  test('targets the GitHub latest alias with the shared asset name', () => {
    expect(STABLE_DMG_URL).toBe(
      `https://github.com/inkeep/open-knowledge/releases/latest/download/${DMG_ASSET_NAME}`,
    );
  });
});

describe('major-scoped release resolution', () => {
  test('v0 stable picks the newest v0.* non-prerelease and ignores v1.* and prereleases', () => {
    const releases = [
      release('v1.0.0', { prerelease: false, assetNames: ['latest-mac.yml'] }),
      release('v0.89.19-beta.0', { prerelease: true, assetNames: ['latest-mac.yml'] }),
      release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
      release('v0.89.17', { prerelease: false, assetNames: ['latest-mac.yml'] }),
    ];
    expect(pickLatestReleaseAssetUrl(releases, stableChannel('latest-mac.yml', 0))).toBe(
      dmgUrl('v0.89.18', 'latest-mac.yml'),
    );
    expect(pickLatestReleaseAssetUrl(releases, stableChannel('latest-mac.yml', 1))).toBe(
      dmgUrl('v1.0.0', 'latest-mac.yml'),
    );
  });

  test('major-scoped beta channels isolate v0.*-beta.* from v1.*-beta.*', () => {
    const releases = [
      release('v1.0.0-beta.2', { assetNames: ['beta-mac.yml'] }),
      release('v0.89.18-beta.1', { assetNames: ['beta-mac.yml'] }),
      release('v0.89.18', { prerelease: false, assetNames: ['beta-mac.yml'] }),
    ];
    expect(pickLatestReleaseAssetUrl(releases, betaChannel('beta-mac.yml', 0))).toBe(
      dmgUrl('v0.89.18-beta.1', 'beta-mac.yml'),
    );
    expect(pickLatestReleaseAssetUrl(releases, betaChannel('beta-mac.yml', 1))).toBe(
      dmgUrl('v1.0.0-beta.2', 'beta-mac.yml'),
    );
  });

  test('v0 stable falls back to git matching-refs when v0 releases age past MAX_RELEASE_PAGES', async () => {
    const requestedUrls: string[] = [];
    const resolve = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 0,
      now: () => 0,
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('/releases?')) {
          return jsonResponse(
            Array.from({ length: 100 }, (_, i) =>
              release(`v1.0.0-cloud.${1000 + i}`, { assetNames: [CLOUD_DMG_ASSET_NAME] }),
            ),
          );
        }
        if (url.endsWith('/git/matching-refs/tags/v0.')) {
          return jsonResponse([
            { ref: 'refs/tags/v0.89.17' },
            { ref: 'refs/tags/v0.89.18-beta.0' },
            { ref: 'refs/tags/v0.89.18' },
            { ref: 'refs/tags/v0.89.19' },
          ]);
        }
        if (url.endsWith('/releases/tags/v0.89.19')) {
          return new Response('Not Found', { status: 404 });
        }
        if (url.endsWith('/releases/tags/v0.89.18')) {
          return jsonResponse(
            release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          );
        }
        return new Response('unexpected', { status: 500 });
      },
    });

    expect(await resolve()).toEqual({
      kind: 'fresh',
      url: dmgUrl('v0.89.18', 'latest-mac.yml'),
    });
    expect(requestedUrls.some((url) => url.endsWith('/git/matching-refs/tags/v0.'))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith('/releases/tags/v0.89.18'))).toBe(true);
  });

  test('v1 stable falls back cleanly when no v1.* stable release exists yet', async () => {
    const resolve = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 1,
      now: () => 0,
      fetchImpl: async () =>
        jsonResponse([
          release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          release('v1.0.0-beta.0', { prerelease: true, assetNames: ['latest-mac.yml'] }),
        ]),
    });

    const result = await resolve();
    expect(result.kind).toBe('fallback');
    expect(result.url).toBe(RELEASES_PAGE_URL);
  });

  test('matching-refs fallback reports tag-lookup details and warns on malformed by-tag payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolve = createStableResolver({
        assetName: 'latest-mac.yml',
        major: 0,
        now: () => 0,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes('/releases?')) {
            return jsonResponse(
              Array.from({ length: 100 }, (_, i) =>
                release(`v1.0.0-cloud.${1000 + i}`, { assetNames: [CLOUD_DMG_ASSET_NAME] }),
              ),
            );
          }
          if (url.endsWith('/git/matching-refs/tags/v0.')) {
            return jsonResponse([{ ref: 'refs/tags/v0.89.18' }]);
          }
          if (url.endsWith('/releases/tags/v0.89.18')) {
            return jsonResponse({ tag_name: 42 });
          }
          return new Response('unexpected', { status: 500 });
        },
      });

      const result = await resolve();
      expect(result.kind).toBe('fallback');
      if (result.kind === 'fallback') {
        expect(result.cause).toContain('via v0. tag lookup (1 matching tag(s) checked)');
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('release payload for tag v0.89.18 failed schema validation'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GITHUB_TOKEN 401 anonymous retry and shared releases cache', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('retries anonymously and logs a warning when GITHUB_TOKEN is refused with HTTP 401', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_expired_token');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seenAuthHeaders: Array<string | undefined> = [];
    try {
      const resolve = createStableResolver({
        assetName: 'latest-mac.yml',
        major: 0,
        now: () => 0,
        fetchImpl: async (_input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string | undefined>;
          seenAuthHeaders.push(headers.authorization);
          if (headers.authorization) {
            return jsonResponse({ message: 'Bad credentials' }, 401);
          }
          return jsonResponse([
            release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          ]);
        },
      });

      expect(await resolve()).toEqual({
        kind: 'fresh',
        url: dmgUrl('v0.89.18', 'latest-mac.yml'),
      });
      expect(seenAuthHeaders).toEqual(['Bearer ghp_expired_token', undefined]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('HTTP 401: the GITHUB_TOKEN this deployment sent was refused'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('does not retry a 401 when GITHUB_TOKEN is unset', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    let calls = 0;
    const resolve = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 0,
      now: () => 0,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ message: 'Unauthorized' }, 401);
      },
    });

    const result = await resolve();
    expect(result.kind).toBe('fallback');
    expect(calls).toBe(1);
  });

  test('shares a single cached GitHub releases page fetch across multiple channel resolvers', async () => {
    let calls = 0;
    let clock = 0;
    const pageCache = createReleasesPageCache({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return jsonResponse([
          release('v1.0.0', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          release('v0.89.18-beta.1', { prerelease: true, assetNames: ['beta-mac.yml'] }),
        ]);
      },
    });

    const resolveV0Stable = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 0,
      now: () => clock,
      pageCache,
    });
    const resolveV1Stable = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 1,
      now: () => clock,
      pageCache,
    });
    const resolveV0Beta = createBetaResolver({
      assetName: 'beta-mac.yml',
      major: 0,
      now: () => clock,
      pageCache,
    });

    const [v0Stable, v1Stable, v0Beta] = await Promise.all([
      resolveV0Stable(),
      resolveV1Stable(),
      resolveV0Beta(),
    ]);
    expect(v0Stable).toEqual({ kind: 'fresh', url: dmgUrl('v0.89.18', 'latest-mac.yml') });
    expect(v1Stable).toEqual({ kind: 'fresh', url: dmgUrl('v1.0.0', 'latest-mac.yml') });
    expect(v0Beta).toEqual({ kind: 'fresh', url: dmgUrl('v0.89.18-beta.1', 'beta-mac.yml') });
    expect(calls).toBe(1);

    clock = 300_000;
    await resolveV0Stable();
    expect(calls).toBe(2);
  });

  test('marks dormant v1 channels as notPublished and preserves notPublished across miss cooldown', async () => {
    let clock = 1_000;
    let calls = 0;
    const resolveV1Stable = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 1,
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return jsonResponse([
          release('v0.89.18', { prerelease: false, assetNames: ['latest-mac.yml'] }),
          release('v1.0.0-beta.2', { prerelease: true, assetNames: ['beta-mac.yml'] }),
        ]);
      },
    });

    const first = await resolveV1Stable();
    expect(first).toMatchObject({
      kind: 'fallback',
      url: RELEASES_PAGE_URL,
      notPublished: true,
    });
    expect(calls).toBe(1);

    clock += 5_000;
    const cachedMiss = await resolveV1Stable();
    expect(cachedMiss).toMatchObject({
      kind: 'fallback',
      url: RELEASES_PAGE_URL,
      notPublished: true,
    });
    expect(calls).toBe(1);
  });

  test('does not mark GitHub API or network outages as notPublished, including across miss cooldown', async () => {
    let clock = 1_000;
    let calls = 0;
    const resolveV1Stable = createStableResolver({
      assetName: 'latest-mac.yml',
      major: 1,
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return new Response('upstream error', { status: 503 });
      },
    });

    const first = await resolveV1Stable();
    expect(first.kind).toBe('fallback');
    if (first.kind === 'fallback') {
      expect(first.notPublished).toBeUndefined();
    }
    expect(calls).toBe(1);

    clock += 5_000;
    const cachedMiss = await resolveV1Stable();
    expect(cachedMiss.kind).toBe('fallback');
    if (cachedMiss.kind === 'fallback') {
      expect(cachedMiss.notPublished).toBeUndefined();
    }
    expect(calls).toBe(1);
  });
});
