import {
  betaChannel,
  createBetaResolver,
  createStableResolver,
  stableChannel,
} from '@/lib/download-links';
import { captureServerEvent, resolveDistinctId, userAgentProperties } from '@/lib/track';

export const dynamic = 'force-dynamic';

const RELEASES_BASE = 'https://github.com/inkeep/open-knowledge/releases';
const BETA_PRODUCT_PREFIX = 'OpenKnowledge-Beta-';
const MANIFEST_SUFFIXES = ['.yml', '-mac.yml', '-linux.yml', '-linux-arm64.yml'] as const;

const V0_STABLE_FALLBACK_TAG = 'v0.89.17';
const V0_BETA_FALLBACK_TAG = 'v0.89.17-beta.0';

const CHANNELS = {
  stable: {
    manifestPrefix: 'latest',
    productPrefix: 'OpenKnowledge-',
    prerelease: false,
    major: 0,
    tagPattern: stableChannel('latest-mac.yml', 0).tagPattern,
    fallbackTag: V0_STABLE_FALLBACK_TAG,
  },
  beta: {
    manifestPrefix: 'beta',
    productPrefix: 'OpenKnowledge-',
    prerelease: true,
    major: 0,
    tagPattern: betaChannel('beta-mac.yml', 0).tagPattern,
    fallbackTag: V0_BETA_FALLBACK_TAG,
  },
  'beta-product': {
    manifestPrefix: 'beta-product',
    productPrefix: BETA_PRODUCT_PREFIX,
    prerelease: true,
    major: 0,
    tagPattern: betaChannel('beta-product-mac.yml', 0).tagPattern,
    fallbackTag: V0_BETA_FALLBACK_TAG,
  },
  'v1-stable': {
    manifestPrefix: 'latest',
    productPrefix: 'OpenKnowledge-',
    prerelease: false,
    major: 1,
    tagPattern: stableChannel('latest-mac.yml', 1).tagPattern,
    fallbackTag: null,
  },
  'v1-beta': {
    manifestPrefix: 'beta',
    productPrefix: 'OpenKnowledge-',
    prerelease: true,
    major: 1,
    tagPattern: betaChannel('beta-mac.yml', 1).tagPattern,
    fallbackTag: null,
  },
  'v1-beta-product': {
    manifestPrefix: 'beta-product',
    productPrefix: BETA_PRODUCT_PREFIX,
    prerelease: true,
    major: 1,
    tagPattern: betaChannel('beta-product-mac.yml', 1).tagPattern,
    fallbackTag: null,
  },
} as const;
type UpdateChannel = keyof typeof CHANNELS;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const ARTIFACT_VERSION =
  /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:arm64|x64|universal)-mac\.zip(?:\.blockmap)?$/;
const MANIFEST = /^(?:latest|beta|beta-product)(?:-mac|-linux(?:-arm64)?)?\.yml$/;
const TAG_FROM_URL = /\/releases\/download\/([^/]+)\//;
const HEADER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function headerVersion(request: Request, name: string): string | undefined {
  const raw = request.headers.get(name);
  return raw && HEADER_VERSION.test(raw) ? raw : undefined;
}
const VERSION_FROM_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

const channelResolvers = new Map(
  (Object.keys(CHANNELS) as UpdateChannel[]).flatMap((channel) => {
    const config = CHANNELS[channel];
    return MANIFEST_SUFFIXES.map((suffix) => {
      const assetName = `${config.manifestPrefix}${suffix}`;
      const resolver = config.prerelease
        ? createBetaResolver({ assetName, major: config.major })
        : createStableResolver({ assetName, major: config.major });
      return [`${channel}:${assetName}`, resolver] as const;
    });
  }),
);

type ArtifactType = 'manifest' | 'zip' | 'blockmap' | 'dmg' | 'exe' | 'deb' | 'rpm' | 'other';

type UpdateOs = 'macos' | 'windows' | 'linux';
type UpdateArch = 'arm64' | 'x64' | 'universal';

const OS_BY_ARTIFACT: Partial<Record<ArtifactType, UpdateOs>> = {
  zip: 'macos',
  exe: 'windows',
  deb: 'linux',
  rpm: 'linux',
};

const ARCH_BY_TOKEN: Record<string, UpdateArch> = {
  arm64: 'arm64',
  aarch64: 'arm64',
  x64: 'x64',
  amd64: 'x64',
  x86_64: 'x64',
  universal: 'universal',
};

const ARCH_TOKEN = /-([A-Za-z0-9_]+)(?:-mac)?\.(?:zip|exe|deb|rpm)$/;

function archOf(filename: string): UpdateArch | undefined {
  const token = ARCH_TOKEN.exec(filename)?.[1];
  return token ? ARCH_BY_TOKEN[token] : undefined;
}

function classify(filename: string): ArtifactType {
  if (MANIFEST.test(filename)) return 'manifest';
  if (filename.endsWith('.blockmap')) return 'blockmap';
  if (filename.endsWith('.zip')) return 'zip';
  if (filename.endsWith('.dmg')) return 'dmg';
  if (filename.endsWith('.exe')) return 'exe';
  if (filename.endsWith('.deb')) return 'deb';
  if (filename.endsWith('.rpm')) return 'rpm';
  return 'other';
}

function redirect302(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

function errorResponse(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

function dormantNotFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'cache-control': 'public, max-age=60, s-maxage=60' },
  });
}

type ChannelTagLookup =
  | { readonly kind: 'ok'; readonly tag: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error' };

function manifestFor(channel: UpdateChannel, filename: string, type: ArtifactType): string {
  const prefix = CHANNELS[channel].manifestPrefix;
  if (type === 'manifest') return filename;
  if (type === 'exe') return `${prefix}.yml`;
  if (type === 'deb' || type === 'rpm') {
    return `${prefix}-linux${archOf(filename) === 'arm64' ? '-arm64' : ''}.yml`;
  }
  return `${prefix}-mac.yml`;
}

async function latestChannelTag(
  channel: UpdateChannel,
  filename: string,
  type: ArtifactType,
): Promise<ChannelTagLookup> {
  const manifest = manifestFor(channel, filename, type);
  const resolve = channelResolvers.get(`${channel}:${manifest}`);
  if (!resolve) return { kind: 'error' };
  const redirect = await resolve();
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[updates/${channel}] serving stale LKG tag after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') {
    const fallbackTag = CHANNELS[channel].fallbackTag;
    if (fallbackTag) {
      console.warn(
        `[updates/${channel}] ${manifest} resolver fell back (${redirect.cause}); serving pinned floor ${fallbackTag}`,
      );
      return { kind: 'ok', tag: fallbackTag };
    }
    if (redirect.notPublished === true) {
      return { kind: 'not-found' };
    }
    console.error(`[updates/${channel}] ${manifest} resolver fell back: ${redirect.cause}`);
    return { kind: 'error' };
  }
  const tag = TAG_FROM_URL.exec(redirect.url)?.[1];
  return tag ? { kind: 'ok', tag } : { kind: 'error' };
}

function isUpdateChannel(value: string): value is UpdateChannel {
  return Object.hasOwn(CHANNELS, value);
}

function matchesChannelIdentity(
  channel: UpdateChannel,
  filename: string,
  type: ArtifactType,
): boolean {
  const config = CHANNELS[channel];
  if (type === 'manifest') {
    return MANIFEST_SUFFIXES.some((suffix) => filename === `${config.manifestPrefix}${suffix}`);
  }
  if (!filename.startsWith(config.productPrefix)) return false;
  return config.productPrefix === BETA_PRODUCT_PREFIX || !filename.startsWith(BETA_PRODUCT_PREFIX);
}

function matchesChannelVersion(channel: UpdateChannel, version: string): boolean {
  return CHANNELS[channel].tagPattern.test(`v${version}`);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ channel: string; path: string[] }> },
): Promise<Response> {
  const { channel, path } = await params;
  if (!isUpdateChannel(channel)) return errorResponse(404);

  const filename = path.join('/');
  if (path.length !== 1 || !SAFE_FILENAME.test(filename)) return errorResponse(404);

  const type = classify(filename);
  if (type === 'other' || !matchesChannelIdentity(channel, filename, type)) {
    return errorResponse(404);
  }

  const version = ARTIFACT_VERSION.exec(filename)?.[1];
  if (version && !matchesChannelVersion(channel, version)) {
    return errorResponse(404);
  }

  let target: string;
  let resolvedTagVersion: string | undefined;
  if (version) {
    target = `${RELEASES_BASE}/download/v${version}/${filename}`;
  } else {
    const lookup = await latestChannelTag(channel, filename, type);
    if (lookup.kind === 'not-found') {
      return dormantNotFoundResponse();
    }
    if (lookup.kind === 'error') {
      return errorResponse(503);
    }
    target = `${RELEASES_BASE}/download/${lookup.tag}/${filename}`;
    resolvedTagVersion = VERSION_FROM_TAG.exec(lookup.tag)?.[1];
  }

  const counted =
    (type === 'zip' && version != null) || type === 'exe' || type === 'deb' || type === 'rpm';
  if (counted) {
    captureServerEvent({
      event: 'app_update_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel,
        artifact_type: type,
        os: OS_BY_ARTIFACT[type],
        arch: archOf(filename),
        to_version: version ?? resolvedTagVersion,
        from_version: headerVersion(request, 'x-ok-from-version'),
        ...userAgentProperties(request),
      },
    });
  }

  return redirect302(target);
}
