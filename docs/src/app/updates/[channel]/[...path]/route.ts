import { createBetaResolver } from '@/lib/download-links';
import { captureServerEvent, resolveDistinctId } from '@/lib/track';

/**
 * Update-feed proxy: openknowledge.ai/updates/{stable,beta}/<asset>
 *
 * electron-updater is pointed here (in a later desktop change) instead of at
 * GitHub directly, so updates can be counted per version. Every request is a
 * thin 302 to the byte-identical GitHub release asset — never re-hosted, so the
 * manifest `sha512` and the macOS code signature both stay valid. Only the
 * `*-mac.zip` (the artifact Squirrel.Mac swaps in) is counted as an update; the
 * manifest poll, the `.blockmap`, and the human `.dmg` flow through uncounted.
 *
 * Redirects are 302, never 301: a cached 301 would let clients skip the proxy
 * and silently stop counting.
 */
export const dynamic = 'force-dynamic';

const RELEASES_BASE = 'https://github.com/inkeep/open-knowledge/releases';
const VALID_CHANNELS = new Set(['stable', 'beta']);
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
// electron-builder's mac update zip: `<productName>-<version>-<arch>-mac.zip`
// (and `.blockmap`). The version is embedded, so it pins the tagged release.
const ARTIFACT_VERSION =
  /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:arm64|x64|universal)-mac\.zip(?:\.blockmap)?$/;
const BETA_TAG_FROM_URL = /\/releases\/download\/([^/]+)\//;
// Validates the attacker-controlled x-ok-from-version header before it lands in
// analytics, so it cannot pollute PostHog with high-cardinality junk.
const FROM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const resolveBeta = createBetaResolver();

type ArtifactType = 'manifest' | 'zip' | 'blockmap' | 'dmg' | 'other';

function classify(filename: string): ArtifactType {
  if (filename.endsWith('-mac.yml')) return 'manifest';
  // Covers both `*.zip.blockmap` and `*.dmg.blockmap` (the release uploads both).
  if (filename.endsWith('.blockmap')) return 'blockmap';
  if (filename.endsWith('.zip')) return 'zip';
  if (filename.endsWith('.dmg')) return 'dmg';
  return 'other';
}

function redirect302(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

// no-store so a transient 404/503 is never CDN-cached for a path that later resolves.
function errorResponse(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/** Newest published beta tag, derived from the beta DMG resolver's URL. */
async function latestBetaTag(): Promise<string | null> {
  const redirect = await resolveBeta();
  if (redirect.kind === 'stale-lkg') {
    console.warn(
      `[updates/beta] serving stale LKG tag after refresh failure: ${redirect.refreshError}`,
    );
  }
  if (redirect.kind === 'fallback') return null;
  return BETA_TAG_FROM_URL.exec(redirect.url)?.[1] ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ channel: string; path: string[] }> },
): Promise<Response> {
  const { channel, path } = await params;
  if (!VALID_CHANNELS.has(channel)) return errorResponse(404);

  const filename = path.join('/');
  if (!SAFE_FILENAME.test(filename)) return errorResponse(404);

  const type = classify(filename);
  if (type === 'other') return errorResponse(404);

  const version = ARTIFACT_VERSION.exec(filename)?.[1];

  // A version embedded in the filename pins the tagged release for either
  // channel; otherwise stable uses the `latest` alias and beta resolves its
  // newest prerelease tag (the manifest poll lands here).
  let target: string;
  if (version) {
    target = `${RELEASES_BASE}/download/v${version}/${filename}`;
  } else if (channel === 'stable') {
    target = `${RELEASES_BASE}/latest/download/${filename}`;
  } else {
    const tag = await latestBetaTag();
    if (!tag) {
      // GitHub API unavailable — let the updater retry on its next interval.
      return errorResponse(503);
    }
    target = `${RELEASES_BASE}/download/${tag}/${filename}`;
  }

  // Count only a real mac-update zip (one with a parseable version); a bare
  // `.zip` with no embedded version is not an electron-updater artifact.
  if (type === 'zip' && version) {
    const rawFrom = request.headers.get('x-ok-from-version');
    captureServerEvent({
      event: 'app_update_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel,
        artifact_type: 'zip',
        to_version: version,
        from_version: rawFrom && FROM_VERSION.test(rawFrom) ? rawFrom : undefined,
      },
    });
  }

  return redirect302(target);
}
