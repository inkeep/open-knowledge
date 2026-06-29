import { describe, expect, test } from 'bun:test';
import {
  createBetaResolver,
  DMG_ASSET_NAME,
  FALLBACK_CACHE_CONTROL,
  pickLatestBetaDmgUrl,
  RELEASES_PAGE_URL,
  STABLE_DMG_URL,
  SUCCESS_CACHE_CONTROL,
  toRedirectResponse,
} from './download-links.ts';

function release(
  tag: string,
  opts: { draft?: boolean; prerelease?: boolean; assetNames?: string[]; assetHost?: string } = {},
) {
  const {
    draft = false,
    prerelease = true,
    assetNames = [DMG_ASSET_NAME],
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

function dmgUrl(tag: string) {
  return `https://github.com/inkeep/open-knowledge/releases/download/${tag}/${DMG_ASSET_NAME}`;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe('pickLatestBetaDmgUrl', () => {
  test('picks the highest-versioned published beta', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.12.0-beta.7'),
      release('v0.12.0-beta.6'),
      release('v0.11.0', { prerelease: false }),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.7'));
  });

  test('ranks by version, not the array order GitHub returns (older beta listed first)', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.20.0-beta.9'),
      release('v0.20.0-beta.8'),
      release('v0.20.0-beta.13'),
      release('v0.20.0-beta.12'),
      release('v0.20.0-beta.10'),
    ]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.13'));
  });

  test('beta.10 outranks beta.9 (no lexical tag compare)', () => {
    const url = pickLatestBetaDmgUrl([release('v0.20.0-beta.9'), release('v0.20.0-beta.10')]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.10'));
  });

  test('ranks across base versions (minor/patch), not just the beta counter', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.20.0-beta.99'),
      release('v0.21.0-beta.1'),
      release('v0.20.1-beta.2'),
    ]);
    expect(url).toBe(dmgUrl('v0.21.0-beta.1'));
  });

  test('skips the newest beta when its DMG is missing, ranking the next-newest', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.20.0-beta.13', { assetNames: ['beta-mac.yml'] }),
      release('v0.20.0-beta.12'),
      release('v0.20.0-beta.9'),
    ]);
    expect(url).toBe(dmgUrl('v0.20.0-beta.12'));
  });

  test('skips stable releases even when they appear first', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.11.0', { prerelease: false }),
      release('v0.11.0-beta.3'),
    ]);
    expect(url).toBe(dmgUrl('v0.11.0-beta.3'));
  });

  test('skips a beta whose DMG never uploaded and falls back to the previous one', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.12.0-beta.7', { assetNames: ['beta-mac.yml'] }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('skips drafts', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.12.0-beta.7', { draft: true }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('skips prereleases that are not -beta.N tags', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.12.0-rc.1'),
      release('beta-latest'),
      release('v0.12.0-beta'),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('rejects asset URLs outside our release-download prefix', () => {
    const url = pickLatestBetaDmgUrl([
      release('v0.12.0-beta.7', { assetHost: 'https://evil.example.com/releases/download' }),
      release('v0.12.0-beta.6'),
    ]);
    expect(url).toBe(dmgUrl('v0.12.0-beta.6'));
  });

  test('returns null when no published beta carries the DMG', () => {
    expect(pickLatestBetaDmgUrl([release('v0.11.0', { prerelease: false })])).toBeNull();
    expect(pickLatestBetaDmgUrl([])).toBeNull();
  });

  test('returns null on malformed payloads instead of throwing', () => {
    expect(pickLatestBetaDmgUrl(null)).toBeNull();
    expect(pickLatestBetaDmgUrl({ message: 'API rate limit exceeded' })).toBeNull();
    expect(pickLatestBetaDmgUrl([{ tag_name: 42 }])).toBeNull();
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

describe('STABLE_DMG_URL', () => {
  test('targets the GitHub latest alias with the shared asset name', () => {
    expect(STABLE_DMG_URL).toBe(
      `https://github.com/inkeep/open-knowledge/releases/latest/download/${DMG_ASSET_NAME}`,
    );
  });
});
