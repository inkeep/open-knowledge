import { createBetaResolver } from '@/lib/download-links';
import { captureServerEvent, resolveDistinctId, userAgentProperties } from '@/lib/track';

export const dynamic = 'force-dynamic';

const RELEASES_BASE = 'https://github.com/inkeep/open-knowledge/releases';
const CHANNELS = {
  stable: { manifestPrefix: 'latest', productPrefix: 'OpenKnowledge-' },
  beta: { manifestPrefix: 'beta', productPrefix: 'OpenKnowledge-Beta-' },
} as const;
type UpdateChannel = keyof typeof CHANNELS;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const ARTIFACT_VERSION =
  /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:arm64|x64|universal)-mac\.zip(?:\.blockmap)?$/;
const MANIFEST = /^(?:latest|beta)(?:-mac|-linux(?:-arm64)?)?\.yml$/;
const TAG_FROM_URL = /\/releases\/download\/([^/]+)\//;
const HEADER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function headerVersion(request: Request, name: string): string | undefined {
  const raw = request.headers.get(name);
  return raw && HEADER_VERSION.test(raw) ? raw : undefined;
}
const VERSION_FROM_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

const resolveBeta = createBetaResolver();

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

async function latestBetaTag(): Promise<string | null> {
  const redirect = await resolveBeta();
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[updates/beta] serving stale LKG tag after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') return null;
  return TAG_FROM_URL.exec(redirect.url)?.[1] ?? null;
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
    return (
      filename.startsWith(`${config.manifestPrefix}-`) ||
      filename === `${config.manifestPrefix}.yml`
    );
  }
  if (!filename.startsWith(config.productPrefix)) return false;
  return channel !== 'stable' || !filename.startsWith(CHANNELS.beta.productPrefix);
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

  let target: string;
  let resolvedTagVersion: string | undefined;
  if (version) {
    target = `${RELEASES_BASE}/download/v${version}/${filename}`;
  } else if (channel === 'stable') {
    target = `${RELEASES_BASE}/latest/download/${filename}`;
  } else {
    const tag = await latestBetaTag();
    if (!tag) {
      return errorResponse(503);
    }
    target = `${RELEASES_BASE}/download/${tag}/${filename}`;
    resolvedTagVersion = VERSION_FROM_TAG.exec(tag)?.[1];
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
        to_version: version ?? resolvedTagVersion ?? headerVersion(request, 'x-ok-to-version'),
        from_version: headerVersion(request, 'x-ok-from-version'),
        ...userAgentProperties(request),
      },
    });
  }

  return redirect302(target);
}
