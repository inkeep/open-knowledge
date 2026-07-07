import { z } from 'zod';

/**
 * Perennial download-URL resolution for both release channels.
 *
 * GitHub's `releases/latest/download/...` alias deliberately skips
 * prereleases, and every OpenKnowledge beta is published as a prerelease,
 * so the beta channel has no GitHub-native perennial URL. A rolling `beta`
 * tag on the repo is not an option either: the desktop auto-updater walks
 * `releases.atom`, and a permanent non-semver tag in that feed breaks
 * electron-updater's version parse on several resolution paths. The
 * docs-site redirect routes under /download/* are the perennial URLs
 * instead; this module owns their resolution and response shapes.
 */
const RELEASES_API_URL = 'https://api.github.com/repos/inkeep/open-knowledge/releases?per_page=15';

/**
 * Both channels upload the DMG under this version-less name — pinned by
 * `artifactName` in packages/desktop/electron-builder.yml, whose comment
 * cross-references this file. Changing either side breaks the other.
 *
 * MUST match the asset name on whatever `releases/latest` (the stable alias)
 * and the beta resolver point at. The OpenKnowledge rename flipped `productName`,
 * so the build now emits `OpenKnowledge-arm64.dmg` — this was flipped to match.
 * Only flip this in lockstep with the release that first publishes the new name
 * as the `latest` *stable*, or `/download/stable` + the marketing/quickstart
 * links 404. Every in-repo download link derives from this constant; the lone
 * exception is the public overlay README
 * (`copybara/public-open-knowledge-overlay/README.md`), a static markdown file
 * that can't import it — flipped in the same pass.
 */
export const DMG_ASSET_NAME = 'OpenKnowledge-arm64.dmg';

/**
 * Stable channel needs no API call: GitHub resolves `releases/latest` to
 * the newest non-prerelease at request time, and the asset name is stable.
 * Single source for the macOS DMG file URL: site.ts re-exports it as
 * `DOWNLOAD_URL` for the JSON-LD schema, and the `/download/stable` route 302s
 * to it. User-facing CTAs link the tracked `DOWNLOAD_ROUTE` redirect instead, so
 * the asset name lives only in {@link DMG_ASSET_NAME} (which tracks the
 * `artifactName` invariant in packages/desktop/electron-builder.yml).
 */
export const STABLE_DMG_URL = `https://github.com/inkeep/open-knowledge/releases/latest/download/${DMG_ASSET_NAME}`;

/**
 * Degraded-path target: a human clicking a shared link during a GitHub API
 * failure still lands somewhere actionable.
 */
export const RELEASES_PAGE_URL = 'https://github.com/inkeep/open-knowledge/releases';

/**
 * Redirect targets must point at our own release assets. The API response
 * is the only untrusted-ish input in this module; any asset URL outside
 * this prefix is treated as no-match rather than followed.
 */
const ASSET_URL_PREFIX = 'https://github.com/inkeep/open-knowledge/releases/download/';

/**
 * The release pipeline only ever cuts `-beta.N` prereleases
 * (desktop-release.yml fail-fasts on any other prerelease ID). Anything
 * else in the listing is unexpected and must not be served as "the beta".
 * The four capture groups (major, minor, patch, beta) are parsed to a
 * numeric rank so the newest beta is chosen by version, never list order.
 */
const BETA_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

type BetaRank = readonly [number, number, number, number];

/** Compare two numeric version ranks lexicographically; >0 when `a` is newer. */
function compareBetaRank(a: BetaRank, b: BetaRank): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// Must match s-maxage in SUCCESS_CACHE_CONTROL — CDN per-PoP TTL and in-process LKG TTL
// are kept equal so freshness guarantees compose predictably.
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

/**
 * Pick the download URL of the newest published beta DMG from a GitHub
 * "List releases" payload. Returns null when the payload is malformed or no
 * published `-beta.N` release carries the DMG asset at a valid URL — e.g. a
 * beta whose desktop-release run failed before upload is skipped in favor of
 * the next-newest one that did upload.
 *
 * The newest beta is chosen by numeric (major, minor, patch, beta) rank, NOT
 * by the payload's array order: GitHub's "List releases" order is not a
 * reliable version sort (it has been observed returning an older beta first),
 * and a lexical tag compare is worse still — "…-beta.9" sorts above
 * "…-beta.10". Both bugs surface the moment betas cross from single- to
 * double-digit, so rank explicitly.
 */
export function pickLatestBetaDmgUrl(payload: unknown): string | null {
  const parsed = releasesSchema.safeParse(payload);
  if (!parsed.success) {
    // Schema drift (GitHub renames/retypes a field) would otherwise be
    // indistinguishable in logs from "no beta exists" — surface the
    // field-level mismatch so an operator can tell the two apart.
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

/**
 * Flatten an error and its immediate cause into one log-friendly string —
 * the cause carries the actionable detail for JSON-parse failures (the
 * SyntaxError) and timeout aborts, and would otherwise be dropped by
 * `err.message`.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause === undefined) return err.message;
  const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
  return `${err.message} [cause: ${cause}]`;
}

/**
 * Build a beta resolver with its own last-known-good (LKG) state.
 *
 * The caching is deliberately explicit module/closure state rather than the
 * framework's: under `dynamic = 'force-dynamic'` Next.js forces every fetch
 * to no-store (overriding `next.revalidate`), and `unstable_cache`'s
 * behavior when revalidation fails is undocumented. A closure-scoped LKG
 * with an explicit TTL is deterministic and unit-testable, and on refresh
 * failure it keeps serving the last valid DMG link instead of degrading.
 * Serverless caveat: state is per-warm-instance — a cold instance pays one
 * API call; concurrent requests on one instance may double-fetch (benign,
 * last write wins).
 */
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
          // GitHub's API rejects requests without a User-Agent, and undici
          // (Next's fetch) does not set one by default.
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
      // A stale LKG entry is a valid DMG link from <TTL+outage ago — far
      // better for a shared link than an error or a listing page.
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

/**
 * Success responses are CDN-cacheable for 5 minutes per PoP, with a bounded
 * stale-while-revalidate window so a Vercel-function outage degrades to a
 * ≤1h-stale (still valid) beta link instead of an error.
 */
export const SUCCESS_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';

/**
 * Fallback responses must not be cached — recovery should be immediate
 * once GitHub answers again.
 */
export const FALLBACK_CACHE_CONTROL = 'no-store';

/**
 * 302 (not 301/308) so clients re-resolve on every download and never pin
 * a tag; betas cut multiple times a day.
 */
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
