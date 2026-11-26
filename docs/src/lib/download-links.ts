import { z } from 'zod';

const RELEASES_API_URL = 'https://api.github.com/repos/inkeep/open-knowledge/releases';
const MATCHING_TAG_REFS_API_URL =
  'https://api.github.com/repos/inkeep/open-knowledge/git/matching-refs/tags';
const RELEASES_PER_PAGE = 100;
export const MAX_RELEASE_PAGES = 5;
const MAX_TAG_FALLBACK_LOOKUPS = 5;

export const DMG_ASSET_NAME = 'OpenKnowledge-arm64.dmg';
export const BETA_DMG_ASSET_NAME = 'OpenKnowledge-Beta-arm64.dmg';
export const CLOUD_DMG_ASSET_NAME = 'OpenKnowledge-Cloud-arm64.dmg';
export const CLOUD_LINUX_DEB_X64_ASSET_NAME = 'OpenKnowledge-Cloud-amd64.deb';
export const CLOUD_LINUX_DEB_ARM64_ASSET_NAME = 'OpenKnowledge-Cloud-arm64.deb';
export const CLOUD_LINUX_RPM_X64_ASSET_NAME = 'OpenKnowledge-Cloud-x86_64.rpm';
export const CLOUD_LINUX_RPM_ARM64_ASSET_NAME = 'OpenKnowledge-Cloud-aarch64.rpm';

export type CloudDownloadTargetId =
  | 'macos-arm64'
  | 'linux-deb-x64'
  | 'linux-deb-arm64'
  | 'linux-rpm-x64'
  | 'linux-rpm-arm64';

export interface CloudDownloadTarget {
  readonly id: CloudDownloadTargetId;
  readonly os: 'macos' | 'linux';
  readonly arch: 'arm64' | 'x64';
  readonly format: 'dmg' | 'deb' | 'rpm';
  readonly assetName: string;
}

export const CLOUD_DOWNLOAD_TARGETS: readonly CloudDownloadTarget[] = [
  {
    id: 'macos-arm64',
    os: 'macos',
    arch: 'arm64',
    format: 'dmg',
    assetName: CLOUD_DMG_ASSET_NAME,
  },
  {
    id: 'linux-deb-x64',
    os: 'linux',
    arch: 'x64',
    format: 'deb',
    assetName: CLOUD_LINUX_DEB_X64_ASSET_NAME,
  },
  {
    id: 'linux-deb-arm64',
    os: 'linux',
    arch: 'arm64',
    format: 'deb',
    assetName: CLOUD_LINUX_DEB_ARM64_ASSET_NAME,
  },
  {
    id: 'linux-rpm-x64',
    os: 'linux',
    arch: 'x64',
    format: 'rpm',
    assetName: CLOUD_LINUX_RPM_X64_ASSET_NAME,
  },
  {
    id: 'linux-rpm-arm64',
    os: 'linux',
    arch: 'arm64',
    format: 'rpm',
    assetName: CLOUD_LINUX_RPM_ARM64_ASSET_NAME,
  },
] as const;

export function cloudTargetById(id: CloudDownloadTargetId): CloudDownloadTarget {
  const target = CLOUD_DOWNLOAD_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown Cloud download target: ${id}`);
  return target;
}

export function resolveCloudTargetFromParams(params: URLSearchParams): CloudDownloadTarget | null {
  const os = params.get('os');
  const arch = params.get('arch');
  const format = params.get('format');
  if (!os) return null;
  return (
    CLOUD_DOWNLOAD_TARGETS.find(
      (target) => target.os === os && target.arch === arch && target.format === format,
    ) ?? null
  );
}

export const STABLE_DMG_URL = `https://github.com/inkeep/open-knowledge/releases/latest/download/${DMG_ASSET_NAME}`;

const RELEASE_ASSET_BASE = 'https://github.com/inkeep/open-knowledge/releases/latest/download';
export const STABLE_WINDOWS_SETUP_X64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-Setup-x64.exe`;
export const STABLE_WINDOWS_SETUP_ARM64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-Setup-arm64.exe`;
export const LINUX_DEB_X64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-amd64.deb`;
export const LINUX_DEB_ARM64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-arm64.deb`;
export const LINUX_RPM_X64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-x86_64.rpm`;
export const LINUX_RPM_ARM64_URL = `${RELEASE_ASSET_BASE}/OpenKnowledge-aarch64.rpm`;

export const RELEASES_PAGE_URL = 'https://github.com/inkeep/open-knowledge/releases';
export const CLOUD_RELEASES_PAGE_URL = `${RELEASES_PAGE_URL}?q=cloud&expanded=true`;
export const CLOUD_DOWNLOAD_PAGE_PATH = '/cloud-beta/download';

const ASSET_URL_PREFIX = 'https://github.com/inkeep/open-knowledge/releases/download/';

type ReleaseChannel = {
  readonly name: string;
  readonly tagPattern: RegExp;
  readonly prerelease: boolean;
  readonly assetName: string;
  readonly tagRefPrefix?: string;
};

function assertMajor(major: number): void {
  if (!Number.isInteger(major) || major < 0) {
    throw new RangeError(`Expected a non-negative integer major version, received ${major}`);
  }
}

export function betaChannel(assetName = BETA_DMG_ASSET_NAME, major?: number): ReleaseChannel {
  if (major !== undefined) {
    assertMajor(major);
    return {
      name: `v${major}-beta`,
      tagPattern: new RegExp(`^v(${major})\\.(\\d+)\\.(\\d+)-beta\\.(\\d+)$`),
      prerelease: true,
      assetName,
      tagRefPrefix: `v${major}.`,
    };
  }
  return {
    name: 'beta',
    tagPattern: /^v(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/,
    prerelease: true,
    assetName,
  };
}

export function stableChannel(assetName: string, major: number): ReleaseChannel {
  assertMajor(major);
  return {
    name: `v${major}-stable`,
    tagPattern: new RegExp(`^v(${major})\\.(\\d+)\\.(\\d+)$`),
    prerelease: false,
    assetName,
    tagRefPrefix: `v${major}.`,
  };
}

export const CLOUD_CHANNEL: ReleaseChannel = {
  name: 'cloud',
  tagPattern: /^v(\d+)\.(\d+)\.(\d+)-cloud\.(\d+)$/,
  prerelease: true,
  assetName: CLOUD_DMG_ASSET_NAME,
};

type PrereleaseRank = readonly [number, number, number, number];

function comparePrereleaseRank(a: PrereleaseRank, b: PrereleaseRank): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const LKG_TTL_MS = 300_000;

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
    }),
  ),
});

const releasesSchema = z.array(releaseSchema);

const matchingRefsSchema = z.array(
  z.object({
    ref: z.string(),
  }),
);

function parseReleaseRank(tag: string, tagPattern: RegExp): PrereleaseRank | null {
  const parts = tagPattern.exec(tag);
  if (!parts) return null;
  return [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] ? Number(parts[4]) : 0];
}

function matchingAssetUrl(
  release: z.infer<typeof releaseSchema>,
  channel: ReleaseChannel,
): string | null {
  if (release.draft || release.prerelease !== channel.prerelease) return null;
  if (!channel.tagPattern.test(release.tag_name)) return null;
  const asset = release.assets.find(
    (candidate) =>
      candidate.name === channel.assetName &&
      candidate.browser_download_url.startsWith(ASSET_URL_PREFIX),
  );
  return asset?.browser_download_url ?? null;
}

export function pickLatestReleaseAssetUrl(
  payload: unknown,
  channel: ReleaseChannel,
): string | null {
  const parsed = releasesSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      `[download-links] releases payload failed schema validation: ${parsed.error.message}`,
    );
    return null;
  }

  let best: { rank: PrereleaseRank; url: string } | null = null;
  for (const release of parsed.data) {
    const url = matchingAssetUrl(release, channel);
    if (!url) continue;
    const rank = parseReleaseRank(release.tag_name, channel.tagPattern);
    if (!rank) continue;
    if (!best || comparePrereleaseRank(rank, best.rank) > 0) {
      best = { rank, url };
    }
  }
  return best?.url ?? null;
}

export type PrereleaseRedirect =
  | { kind: 'fresh' | 'cached'; url: string }
  | { kind: 'stale-lkg'; url: string; refreshError: string }
  | { kind: 'fallback'; url: string; cause: string };

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause === undefined) return err.message;
  const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
  return `${err.message} [cause: ${cause}]`;
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'openknowledge.ai download redirect',
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGithubResponse(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
): Promise<Response> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(5_000),
    headers: githubApiHeaders(token),
  });
  if (res.status === 401 && token) {
    console.warn(
      `[download-links] ${label} returned HTTP 401: the GITHUB_TOKEN this deployment sent was refused; retrying anonymously`,
    );
    return fetchImpl(url, {
      signal: AbortSignal.timeout(5_000),
      headers: githubApiHeaders(),
    });
  }
  return res;
}

async function fetchGithubJson(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
): Promise<unknown> {
  const res = await fetchGithubResponse(fetchImpl, url, label);
  if (!res.ok) {
    throw new Error(`${label} responded ${res.status}`);
  }
  try {
    return await res.json();
  } catch (parseErr) {
    throw new Error(`${label} returned non-JSON body (status ${res.status})`, {
      cause: parseErr,
    });
  }
}

async function fetchReleasesPage(fetchImpl: typeof fetch, page: number): Promise<unknown> {
  return fetchGithubJson(
    fetchImpl,
    `${RELEASES_API_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
    'GitHub releases API',
  );
}

interface ReleasesPageCache {
  getPage(page: number): Promise<unknown>;
}

export function createReleasesPageCache(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): ReleasesPageCache {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const pages = new Map<number, { payload: unknown; fetchedAt: number }>();
  const inFlight = new Map<number, Promise<unknown>>();

  return {
    getPage(page: number): Promise<unknown> {
      const cached = pages.get(page);
      if (cached && now() - cached.fetchedAt < LKG_TTL_MS) {
        return Promise.resolve(cached.payload);
      }
      const existing = inFlight.get(page);
      if (existing) return existing;
      const pending = fetchReleasesPage(fetchImpl, page)
        .then((payload) => {
          pages.set(page, { payload, fetchedAt: now() });
          return payload;
        })
        .finally(() => {
          inFlight.delete(page);
        });
      inFlight.set(page, pending);
      return pending;
    },
  };
}

const defaultReleasesPageCache = createReleasesPageCache();

async function findLatestAssetUrlViaMatchingRefs(
  fetchImpl: typeof fetch,
  channel: ReleaseChannel,
): Promise<{ url: string | null; checkedTags: number }> {
  if (!channel.tagRefPrefix) return { url: null, checkedTags: 0 };
  const rawRefs = await fetchGithubJson(
    fetchImpl,
    `${MATCHING_TAG_REFS_API_URL}/${encodeURIComponent(channel.tagRefPrefix)}`,
    'GitHub matching-refs API',
  );
  const parsedRefs = matchingRefsSchema.safeParse(rawRefs);
  if (!parsedRefs.success) {
    console.warn(
      `[download-links] matching-refs payload failed schema validation: ${parsedRefs.error.message}`,
    );
    return { url: null, checkedTags: 0 };
  }

  const candidates: Array<{ tag: string; rank: PrereleaseRank }> = [];
  for (const entry of parsedRefs.data) {
    if (!entry.ref.startsWith('refs/tags/')) continue;
    const tag = entry.ref.slice('refs/tags/'.length);
    const rank = parseReleaseRank(tag, channel.tagPattern);
    if (rank) candidates.push({ tag, rank });
  }
  candidates.sort((a, b) => comparePrereleaseRank(b.rank, a.rank));

  let checkedTags = 0;
  for (const { tag } of candidates.slice(0, MAX_TAG_FALLBACK_LOOKUPS)) {
    checkedTags++;
    const res = await fetchGithubResponse(
      fetchImpl,
      `${RELEASES_API_URL}/tags/${encodeURIComponent(tag)}`,
      'GitHub release-by-tag API',
    );
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`GitHub release-by-tag API responded ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (parseErr) {
      throw new Error(`GitHub release-by-tag API returned non-JSON body (status ${res.status})`, {
        cause: parseErr,
      });
    }
    const parsed = releaseSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(
        `[download-links] release payload for tag ${tag} failed schema validation: ${parsed.error.message}`,
      );
      continue;
    }
    const url = matchingAssetUrl(parsed.data, channel);
    if (url) return { url, checkedTags };
  }
  return { url: null, checkedTags };
}

async function findLatestReleaseAssetUrl(
  fetchImpl: typeof fetch,
  channel: ReleaseChannel,
  getPage: (page: number) => Promise<unknown>,
): Promise<string> {
  let exhaustedAllPages = true;
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const payload = await getPage(page);
    const url = pickLatestReleaseAssetUrl(payload, channel);
    if (url) return url;
    if (!Array.isArray(payload) || payload.length < RELEASES_PER_PAGE) {
      exhaustedAllPages = false;
      break;
    }
  }
  if (exhaustedAllPages && channel.tagRefPrefix) {
    const fallback = await findLatestAssetUrlViaMatchingRefs(fetchImpl, channel);
    if (fallback.url) return fallback.url;
    throw new Error(
      `no published ${channel.name} release carries ${channel.assetName} in the newest ${MAX_RELEASE_PAGES * RELEASES_PER_PAGE} releases or via ${channel.tagRefPrefix} tag lookup (${fallback.checkedTags} matching tag(s) checked)`,
    );
  }
  throw new Error(
    `no published ${channel.name} release carries ${channel.assetName} in the newest ${MAX_RELEASE_PAGES * RELEASES_PER_PAGE} releases`,
  );
}

function createReleaseResolver(
  channel: ReleaseChannel,
  deps: { fetchImpl?: typeof fetch; now?: () => number; pageCache?: ReleasesPageCache } = {},
): () => Promise<PrereleaseRedirect> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const pageCache =
    deps.pageCache ??
    (deps.fetchImpl === undefined && deps.now === undefined ? defaultReleasesPageCache : null);
  const getPage = pageCache
    ? (page: number) => pageCache.getPage(page)
    : (page: number) => fetchReleasesPage(fetchImpl, page);
  let lkg: { url: string; fetchedAt: number } | null = null;
  let miss: { refreshError: string; checkedAt: number } | null = null;
  let refreshing: Promise<PrereleaseRedirect> | null = null;

  function afterMiss(refreshError: string): PrereleaseRedirect {
    if (lkg) return { kind: 'stale-lkg', url: lkg.url, refreshError };
    return { kind: 'fallback', url: RELEASES_PAGE_URL, cause: refreshError };
  }

  async function refresh(): Promise<PrereleaseRedirect> {
    try {
      const url = await findLatestReleaseAssetUrl(fetchImpl, channel, getPage);
      lkg = { url, fetchedAt: now() };
      miss = null;
      return { kind: 'fresh', url };
    } catch (err) {
      miss = { refreshError: describeError(err), checkedAt: now() };
      return afterMiss(miss.refreshError);
    }
  }

  return async function resolveReleaseRedirect(): Promise<PrereleaseRedirect> {
    if (lkg && now() - lkg.fetchedAt < LKG_TTL_MS) {
      return { kind: 'cached', url: lkg.url };
    }
    if (miss && now() - miss.checkedAt < LKG_TTL_MS) {
      return afterMiss(miss.refreshError);
    }
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
}

export function createBetaResolver(
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    assetName?: string;
    major?: number;
    pageCache?: ReleasesPageCache;
  } = {},
): () => Promise<PrereleaseRedirect> {
  return createReleaseResolver(betaChannel(deps.assetName, deps.major), deps);
}

export function createStableResolver(deps: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  assetName: string;
  major: number;
  pageCache?: ReleasesPageCache;
}): () => Promise<PrereleaseRedirect> {
  return createReleaseResolver(stableChannel(deps.assetName, deps.major), deps);
}

type CloudAssetMap = Partial<Record<CloudDownloadTargetId, string>>;

type CloudAssetsPartial = {
  readonly error: string;
  readonly freshTargets: ReadonlySet<CloudDownloadTargetId>;
};

type CloudAssetsState =
  | { kind: 'fresh'; assets: CloudAssetMap; partial?: CloudAssetsPartial }
  | { kind: 'cached'; assets: CloudAssetMap; partial?: CloudAssetsPartial }
  | { kind: 'stale-lkg'; assets: CloudAssetMap; error: string }
  | { kind: 'fallback'; error: string };

function mergeLatestCloudAssets(
  payload: unknown,
  found: Map<CloudDownloadTargetId, { rank: PrereleaseRank; url: string }>,
): boolean {
  const parsed = releasesSchema.safeParse(payload);
  if (!parsed.success) {
    console.warn(
      `[download-links] releases payload failed schema validation: ${parsed.error.message}`,
    );
    return false;
  }
  for (const release of parsed.data) {
    if (release.draft || !release.prerelease) continue;
    const parts = CLOUD_CHANNEL.tagPattern.exec(release.tag_name);
    if (!parts) continue;
    const rank: PrereleaseRank = [
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
    ];
    for (const target of CLOUD_DOWNLOAD_TARGETS) {
      const asset = release.assets.find(
        (candidate) =>
          candidate.name === target.assetName &&
          candidate.browser_download_url.startsWith(ASSET_URL_PREFIX),
      );
      if (!asset) continue;
      const existing = found.get(target.id);
      if (!existing || comparePrereleaseRank(rank, existing.rank) > 0) {
        found.set(target.id, { rank, url: asset.browser_download_url });
      }
    }
  }
  return found.size === CLOUD_DOWNLOAD_TARGETS.length;
}

async function findLatestCloudAssets(
  fetchImpl: typeof fetch,
): Promise<{ assets: CloudAssetMap; partial?: CloudAssetsPartial }> {
  const found = new Map<CloudDownloadTargetId, { rank: PrereleaseRank; url: string }>();
  let partialError: string | undefined;
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    let payload: unknown;
    try {
      payload = await fetchReleasesPage(fetchImpl, page);
    } catch (err) {
      if (found.size > 0) {
        partialError = describeError(err);
        console.warn(
          `[download-links] stopping Cloud releases page walk at page ${page} with ${found.size} resolved target(s): ${partialError}`,
        );
        break;
      }
      throw err;
    }
    if (mergeLatestCloudAssets(payload, found)) break;
    if (!Array.isArray(payload) || payload.length < RELEASES_PER_PAGE) break;
  }
  if (found.size === 0) {
    throw new Error(
      `no published cloud release carries any desktop installer in the newest ${MAX_RELEASE_PAGES * RELEASES_PER_PAGE} releases`,
    );
  }
  const assets: CloudAssetMap = {};
  for (const [id, entry] of found) {
    assets[id] = entry.url;
  }
  if (partialError !== undefined) {
    return {
      assets,
      partial: { error: partialError, freshTargets: new Set(found.keys()) },
    };
  }
  return { assets };
}

export function createCloudAssetsResolver(
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): (targetId: CloudDownloadTargetId) => Promise<PrereleaseRedirect> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let lkg: {
    assets: CloudAssetMap;
    fetchedAt: number;
    partial?: CloudAssetsPartial;
  } | null = null;
  let miss: { refreshError: string; checkedAt: number } | null = null;
  let refreshing: Promise<Exclude<CloudAssetsState, { kind: 'cached' }>> | null = null;

  function resolveFromState(
    targetId: CloudDownloadTargetId,
    state: CloudAssetsState,
  ): PrereleaseRedirect {
    if (state.kind === 'fallback') {
      return {
        kind: 'fallback',
        url: CLOUD_RELEASES_PAGE_URL,
        cause: state.error,
      };
    }
    const url = state.assets[targetId];
    if (!url) {
      const cause =
        state.kind === 'stale-lkg'
          ? state.error
          : (state.partial?.error ?? `no published cloud release carries ${targetId}`);
      return {
        kind: 'fallback',
        url: CLOUD_RELEASES_PAGE_URL,
        cause,
      };
    }
    if (state.kind === 'stale-lkg') {
      return { kind: 'stale-lkg', url, refreshError: state.error };
    }
    if (state.partial && !state.partial.freshTargets.has(targetId)) {
      return { kind: 'stale-lkg', url, refreshError: state.partial.error };
    }
    return { kind: state.kind, url };
  }

  async function refresh(): Promise<Exclude<CloudAssetsState, { kind: 'cached' }>> {
    try {
      const { assets, partial } = await findLatestCloudAssets(fetchImpl);
      const mergedAssets = partial && lkg ? { ...lkg.assets, ...assets } : assets;
      lkg = { assets: mergedAssets, fetchedAt: now(), partial };
      miss = null;
      return { kind: 'fresh', assets: mergedAssets, partial };
    } catch (err) {
      const refreshError = describeError(err);
      miss = { refreshError, checkedAt: now() };
      if (lkg) return { kind: 'stale-lkg', assets: lkg.assets, error: refreshError };
      return { kind: 'fallback', error: refreshError };
    }
  }

  return async function resolveCloudAsset(
    targetId: CloudDownloadTargetId,
  ): Promise<PrereleaseRedirect> {
    if (lkg && now() - lkg.fetchedAt < LKG_TTL_MS) {
      return resolveFromState(targetId, {
        kind: 'cached',
        assets: lkg.assets,
        partial: lkg.partial,
      });
    }
    if (miss && now() - miss.checkedAt < LKG_TTL_MS) {
      if (lkg) {
        return resolveFromState(targetId, {
          kind: 'stale-lkg',
          assets: lkg.assets,
          error: miss.refreshError,
        });
      }
      return resolveFromState(targetId, { kind: 'fallback', error: miss.refreshError });
    }
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    const state = await refreshing;
    return resolveFromState(targetId, state);
  };
}

export const SUCCESS_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';

export const FALLBACK_CACHE_CONTROL = 'no-store';

export const PER_VISITOR_CACHE_CONTROL = 'private, no-store';

export function toRedirectResponse(redirect: PrereleaseRedirect): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.url,
      'cache-control':
        redirect.kind === 'fallback' ? FALLBACK_CACHE_CONTROL : SUCCESS_CACHE_CONTROL,
    },
  });
}
