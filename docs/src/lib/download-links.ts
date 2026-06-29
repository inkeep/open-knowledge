import { z } from 'zod';

const RELEASES_API_URL = 'https://api.github.com/repos/inkeep/open-knowledge/releases?per_page=15';

export const DMG_ASSET_NAME = 'OpenKnowledge-arm64.dmg';

export const STABLE_DMG_URL = `https://github.com/inkeep/open-knowledge/releases/latest/download/${DMG_ASSET_NAME}`;

export const RELEASES_PAGE_URL = 'https://github.com/inkeep/open-knowledge/releases';

const ASSET_URL_PREFIX = 'https://github.com/inkeep/open-knowledge/releases/download/';

const BETA_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

type BetaRank = readonly [number, number, number, number];

function compareBetaRank(a: BetaRank, b: BetaRank): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const LKG_TTL_MS = 300_000;

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(
      z.object({
        name: z.string(),
        browser_download_url: z.string(),
      }),
    ),
  }),
);

export function pickLatestBetaDmgUrl(payload: unknown): string | null {
  const parsed = releasesSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      `[download-links] releases payload failed schema validation: ${parsed.error.message}`,
    );
    return null;
  }

  let best: { rank: BetaRank; url: string } | null = null;
  for (const release of parsed.data) {
    if (release.draft || !release.prerelease) continue;
    const parts = BETA_TAG_PATTERN.exec(release.tag_name);
    if (!parts) continue;
    const dmg = release.assets.find(
      (asset) =>
        asset.name === DMG_ASSET_NAME && asset.browser_download_url.startsWith(ASSET_URL_PREFIX),
    );
    if (!dmg) continue;
    const rank: BetaRank = [Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])];
    if (!best || compareBetaRank(rank, best.rank) > 0) {
      best = { rank, url: dmg.browser_download_url };
    }
  }
  return best?.url ?? null;
}

export type BetaRedirect =
  | { kind: 'fresh' | 'cached'; url: string }
  | { kind: 'stale-lkg'; url: string; refreshError: string }
  | { kind: 'fallback'; url: string; cause: string };

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause === undefined) return err.message;
  const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
  return `${err.message} [cause: ${cause}]`;
}

export function createBetaResolver(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): () => Promise<BetaRedirect> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let lkg: { url: string; fetchedAt: number } | null = null;

  return async function resolveBetaRedirect(): Promise<BetaRedirect> {
    if (lkg && now() - lkg.fetchedAt < LKG_TTL_MS) {
      return { kind: 'cached', url: lkg.url };
    }
    try {
      const res = await fetchImpl(RELEASES_API_URL, {
        signal: AbortSignal.timeout(5_000),
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'openknowledge.ai download redirect',
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub releases API responded ${res.status}`);
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch (parseErr) {
        throw new Error(`GitHub releases API returned non-JSON body (status ${res.status})`, {
          cause: parseErr,
        });
      }
      const url = pickLatestBetaDmgUrl(payload);
      if (!url) {
        throw new Error('no published beta release carries the DMG asset');
      }
      lkg = { url, fetchedAt: now() };
      return { kind: 'fresh', url };
    } catch (err) {
      const refreshError = describeError(err);
      if (lkg) return { kind: 'stale-lkg', url: lkg.url, refreshError };
      return {
        kind: 'fallback',
        url: RELEASES_PAGE_URL,
        cause: refreshError,
      };
    }
  };
}

export const SUCCESS_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';

export const FALLBACK_CACHE_CONTROL = 'no-store';

export function toRedirectResponse(redirect: BetaRedirect): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.url,
      'cache-control':
        redirect.kind === 'fallback' ? FALLBACK_CACHE_CONTROL : SUCCESS_CACHE_CONTROL,
    },
  });
}
