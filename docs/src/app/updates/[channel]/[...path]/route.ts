import { createBetaResolver } from '@/lib/download-links';
import { captureServerEvent, resolveDistinctId, userAgentProperties } from '@/lib/track';

/**
 * Update-feed proxy: openknowledge.ai/updates/{stable,beta}/<asset>
 *
 * electron-updater's feed points here instead of at GitHub directly (wired in
 * the desktop app's auto-updater), so updates can be counted per version.
 * Every request is a
 * thin 302 to the byte-identical GitHub release asset — never re-hosted, so the
 * manifest `sha512` and the platform code signatures all stay valid. All three
 * desktop platforms poll here: macOS requests `*-mac.yml` + the versioned
 * `*-mac.zip` Squirrel.Mac swaps in; Windows requests `latest.yml`/`beta.yml` +
 * the NSIS `*.exe`; Linux requests `latest-linux[-arm64].yml` (beta-*) + the
 * `.deb`/`.rpm` its package-manager install consumes. The update ARTIFACTS
 * (zip/exe/deb/rpm) are counted; manifest polls, `.blockmap`s, and the human
 * `.dmg` flow through uncounted.
 *
 * Tag pinning: the mac zip embeds its version, so its redirect pins the tagged
 * release. The exe/deb/rpm names are deliberately versionless (stable
 * `releases/latest/download/` permalinks), so their redirects resolve
 * `latest`/newest-beta at request time — a release landing between the
 * manifest poll and the download can serve the newer file once, which the
 * updater rejects on sha512 mismatch and retries on its next interval.
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
// The electron-updater channel manifests, all platforms: `latest-mac.yml` /
// `beta-mac.yml` (macOS), `latest.yml` / `beta.yml` (Windows, both arches in
// one file), `latest-linux.yml` / `latest-linux-arm64.yml` + beta-* (Linux,
// arch-suffixed by electron-builder exactly as the client computes it).
const MANIFEST = /^(?:latest|beta)(?:-mac|-linux(?:-arm64)?)?\.yml$/;
const BETA_TAG_FROM_URL = /\/releases\/download\/([^/]+)\//;
// Validates the attacker-controlled x-ok-from-version / x-ok-to-version headers
// before they land in analytics, so they cannot pollute PostHog with
// high-cardinality junk.
const HEADER_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

function headerVersion(request: Request, name: string): string | undefined {
  const raw = request.headers.get(name);
  return raw && HEADER_VERSION.test(raw) ? raw : undefined;
}
// A beta tag as cut by the cadence (`v0.20.0-beta.4`) — used to derive
// `to_version` for the versionless installers on the beta channel.
const VERSION_FROM_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

const resolveBeta = createBetaResolver();

type ArtifactType = 'manifest' | 'zip' | 'blockmap' | 'dmg' | 'exe' | 'deb' | 'rpm' | 'other';

type UpdateOs = 'macos' | 'windows' | 'linux';
type UpdateArch = 'arm64' | 'x64' | 'universal';

/**
 * The artifact a platform's updater installs is unique to that platform, so the
 * container names the OS outright: Squirrel.Mac takes the zip, NSIS the exe,
 * and Linux the package its install came from.
 */
const OS_BY_ARTIFACT: Partial<Record<ArtifactType, UpdateOs>> = {
  zip: 'macos',
  exe: 'windows',
  deb: 'linux',
  rpm: 'linux',
};

/**
 * Each artifact spells its architecture the way its own packager does —
 * electron-builder's `arm64`/`x64`, dpkg's `amd64`, rpm's `x86_64`/`aarch64`.
 * Mapping them onto one vocabulary keeps a single `arch` dimension in
 * analytics, and it is deliberately the same vocabulary `download-targets.ts`
 * emits on `dmg_downloaded`, so downloads and updates slice identically.
 * Unknown tokens fall out as undefined rather than reaching PostHog — same
 * bounded-cardinality discipline as the from_version guard.
 */
const ARCH_BY_TOKEN: Record<string, UpdateArch> = {
  arm64: 'arm64',
  aarch64: 'arm64',
  x64: 'x64',
  amd64: 'x64',
  x86_64: 'x64',
  // No universal build ships today, so this has no download-side peer — but
  // the mac-zip name admits one, so classify it rather than dropping it.
  universal: 'universal',
};

/**
 * The arch token is the last hyphen-delimited segment before the extension on
 * every counted artifact (`…-arm64-mac.zip`, `…-Setup-x64.exe`,
 * `…-amd64.deb`, `…-x86_64.rpm`); `-mac` is the one suffix that follows it.
 */
const ARCH_TOKEN = /-([A-Za-z0-9_]+)(?:-mac)?\.(?:zip|exe|deb|rpm)$/;

function archOf(filename: string): UpdateArch | undefined {
  const token = ARCH_TOKEN.exec(filename)?.[1];
  return token ? ARCH_BY_TOKEN[token] : undefined;
}

function classify(filename: string): ArtifactType {
  if (MANIFEST.test(filename)) return 'manifest';
  // Covers both `*.zip.blockmap` and `*.dmg.blockmap` (the release uploads both).
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
  // newest prerelease tag (manifest polls + the versionless installers land
  // here).
  let target: string;
  // On the beta path the resolved tag also names the version the redirect
  // will serve, so the versionless installers can still count a to_version.
  let resolvedTagVersion: string | undefined;
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
    resolvedTagVersion = VERSION_FROM_TAG.exec(tag)?.[1];
  }

  // Count the artifacts electron-updater actually installs: the versioned mac
  // zip (a bare `.zip` with no embedded version is not an updater artifact),
  // and the Windows/Linux installers, whose versionless names carry no
  // to_version of their own — beta fills it from the resolved tag, and stable's
  // `latest` alias resolves nothing, so there the updater's own header is the
  // only source. Humans download installers from the release page / docs links,
  // never through this proxy, and userAgentProperties surfaces any exceptions.
  const counted =
    (type === 'zip' && version != null) || type === 'exe' || type === 'deb' || type === 'rpm';
  if (counted) {
    captureServerEvent({
      event: 'app_update_downloaded',
      distinctId: resolveDistinctId(request),
      properties: {
        channel,
        artifact_type: type,
        // artifact_type already implies the OS, but only to a reader who knows
        // the mapping — os/arch make the platform split directly groupable and
        // name the dimension the same way `dmg_downloaded` does, so a download
        // and the updates that follow it join on one vocabulary.
        os: OS_BY_ARTIFACT[type],
        arch: archOf(filename),
        // Server-derived sources win: the filename and the resolved tag both
        // name what this redirect actually serves, while the header is only
        // the client's claim about what it is installing. It is the last
        // resort, not an override.
        to_version: version ?? resolvedTagVersion ?? headerVersion(request, 'x-ok-to-version'),
        from_version: headerVersion(request, 'x-ok-from-version'),
        // Confirms updates really come from electron-updater and surfaces any
        // scraper/browser traffic hitting the update feed.
        ...userAgentProperties(request),
      },
    });
  }

  return redirect302(target);
}
