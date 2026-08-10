/**
 * The one catalog of downloadable desktop builds, plus the OS classification
 * and URL plumbing every download CTA on the site shares.
 *
 * Two rules shape everything here:
 *
 * 1. **Platform is detectable; architecture is not.** `navigator` reliably
 *    names the OS and nothing else. Apple freezes the macOS UA to "Intel Mac
 *    OS X" on Apple Silicon too, UA Client Hints are Chromium-only and
 *    misreport under Rosetta, and Windows/Linux expose no trustworthy arch
 *    signal at all. So detection picks the OS, a hardcoded guess picks the
 *    arch for the primary click, and every other build stays one click away in
 *    the dropdown.
 * 2. **Clicks flow through the tracked redirect, never straight to GitHub.**
 *    Call sites build hrefs with {@link downloadHrefForTarget}; the
 *    `/download/stable` route resolves the asset and counts the download.
 *    Linking an asset URL directly loses the event.
 */
import {
  LINUX_DEB_ARM64_URL,
  LINUX_DEB_X64_URL,
  LINUX_RPM_ARM64_URL,
  LINUX_RPM_X64_URL,
  STABLE_DMG_URL,
  STABLE_WINDOWS_SETUP_ARM64_URL,
  STABLE_WINDOWS_SETUP_X64_URL,
} from './download-links';
import { type DownloadCta, downloadRouteForCta } from './site';

/** OS a visitor's browser can be classified into. */
export type DetectedOs = 'macos' | 'windows' | 'linux' | 'unknown';

/** The OSes we ship a desktop build for — {@link DetectedOs} minus `unknown`. */
type DownloadOs = Exclude<DetectedOs, 'unknown'>;

type DownloadArch = 'arm64' | 'x64';

/** Installer container. macOS ships one DMG; Linux ships deb and rpm side by side. */
type DownloadFormat = 'dmg' | 'exe' | 'deb' | 'rpm';

/**
 * Stable per-build identifier. Doubles as the analytics discriminator on
 * `dmg_downloaded`, so treat it as append-only — renaming one orphans its
 * dashboard history.
 */
export type DownloadTargetId =
  | 'macos-arm64'
  | 'windows-x64'
  | 'windows-arm64'
  | 'linux-deb-x64'
  | 'linux-deb-arm64'
  | 'linux-rpm-x64'
  | 'linux-rpm-arm64';

export interface DownloadTarget {
  id: DownloadTargetId;
  os: DownloadOs;
  arch: DownloadArch;
  format: DownloadFormat;
  /** Dropdown row label. */
  label: string;
  /** GitHub release asset the tracked redirect ultimately 302s to. */
  assetUrl: string;
}

/**
 * Every desktop build published on a release, in dropdown order: the detected
 * OS's own builds read top-down before the others. macOS has a single entry
 * because only an arm64 DMG is built — Intel Macs run the web app instead
 * (see {@link WEB_APP_HREF}).
 */
export const DOWNLOAD_TARGETS: readonly DownloadTarget[] = [
  {
    id: 'macos-arm64',
    os: 'macos',
    arch: 'arm64',
    format: 'dmg',
    label: 'macOS (Apple Silicon)',
    assetUrl: STABLE_DMG_URL,
  },
  {
    id: 'windows-x64',
    os: 'windows',
    arch: 'x64',
    format: 'exe',
    label: 'Windows (x64)',
    assetUrl: STABLE_WINDOWS_SETUP_X64_URL,
  },
  {
    id: 'windows-arm64',
    os: 'windows',
    arch: 'arm64',
    format: 'exe',
    label: 'Windows (Arm64)',
    assetUrl: STABLE_WINDOWS_SETUP_ARM64_URL,
  },
  {
    id: 'linux-deb-x64',
    os: 'linux',
    arch: 'x64',
    format: 'deb',
    label: 'Linux .deb (x64)',
    assetUrl: LINUX_DEB_X64_URL,
  },
  {
    id: 'linux-deb-arm64',
    os: 'linux',
    arch: 'arm64',
    format: 'deb',
    label: 'Linux .deb (Arm64)',
    assetUrl: LINUX_DEB_ARM64_URL,
  },
  {
    id: 'linux-rpm-x64',
    os: 'linux',
    arch: 'x64',
    format: 'rpm',
    label: 'Linux .rpm (x64)',
    assetUrl: LINUX_RPM_X64_URL,
  },
  {
    id: 'linux-rpm-arm64',
    os: 'linux',
    arch: 'arm64',
    format: 'rpm',
    label: 'Linux .rpm (Arm64)',
    assetUrl: LINUX_RPM_ARM64_URL,
  },
] as const;

/**
 * What the primary button downloads once an OS is detected. x64 wins on
 * Windows and deb-x64 on Linux because those cover the overwhelming majority
 * of desktops; a wrong guess costs one dropdown click, and offering no default
 * costs every visitor one.
 */
const DEFAULT_TARGET_BY_OS: Record<DownloadOs, DownloadTargetId> = {
  macos: 'macos-arm64',
  windows: 'windows-x64',
  linux: 'linux-deb-x64',
};

/**
 * Pre-hydration and unknown-OS floor. macOS is the historical default and the
 * single largest slice of traffic, so a no-JS visitor still gets a working
 * installer rather than a listing page.
 */
const FALLBACK_TARGET_ID: DownloadTargetId = 'macos-arm64';

/**
 * Where the "run it in your browser" dropdown row points. Also the Intel-Mac
 * answer — there is no Intel DMG, so the npm CLI is the only path for those
 * machines.
 */
export const WEB_APP_HREF = '/docs/reference/cli';

/** Dropdown label for {@link WEB_APP_HREF}. */
export const WEB_APP_LABEL = 'Run in your browser (npm)';

export function targetById(id: DownloadTargetId): DownloadTarget {
  const target = DOWNLOAD_TARGETS.find((candidate) => candidate.id === id);
  // The id union is closed and every member is in the catalog, so this is a
  // type-level impossibility rather than a runtime branch worth handling.
  if (!target) throw new Error(`Unknown download target: ${id}`);
  return target;
}

/** The build the primary button fires for a detected OS. */
export function defaultTargetForOs(os: DetectedOs): DownloadTarget {
  return targetById(os === 'unknown' ? FALLBACK_TARGET_ID : DEFAULT_TARGET_BY_OS[os]);
}

/**
 * Catalog order, but with the detected OS's builds hoisted to the top so the
 * alternatives a visitor actually might want (the other arch, the other
 * package format) sit directly under the primary action. Stable within each
 * group — this only partitions, it never reorders siblings.
 */
export function orderTargetsForOs(os: DetectedOs): readonly DownloadTarget[] {
  if (os === 'unknown') return DOWNLOAD_TARGETS;
  return [
    ...DOWNLOAD_TARGETS.filter((target) => target.os === os),
    ...DOWNLOAD_TARGETS.filter((target) => target.os !== os),
  ];
}

/**
 * Classify the visitor's OS from `navigator.userAgentData.platform`
 * (preferred) or `navigator.userAgent` (fallback). Returns platform only,
 * never architecture. Mobile falls through to `unknown` so phones and tablets
 * get the server-rendered floor — they can't run the desktop app at all.
 */
export function classifyDownloadOs(input: string | null | undefined): DetectedOs {
  if (!input) return 'unknown';
  const lower = input.toLowerCase();
  if (
    lower.includes('iphone') ||
    lower.includes('ipad') ||
    lower.includes('android') ||
    lower === 'ios'
  ) {
    return 'unknown';
  }
  if (lower.includes('mac') || lower === 'darwin') return 'macos';
  if (lower.includes('win')) return 'windows';
  if (
    lower.includes('linux') ||
    lower.includes('x11') ||
    lower.includes('cros') ||
    lower.includes('chrome os')
  ) {
    return 'linux';
  }
  return 'unknown';
}

/**
 * Prefer `navigator.userAgentData.platform` (modern, narrow); fall back to the
 * full UA. The DOM lib doesn't type `userAgentData` yet (still draft), so the
 * cast names the shape we read.
 */
export function readPlatformInput(): string | null {
  if (typeof navigator === 'undefined') return null;
  const withUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return withUaData.userAgentData?.platform ?? navigator.userAgent ?? null;
}

/** Primary-button copy. Neutral until an OS is known, so it is never wrong. */
export function downloadLabelForOs(os: DetectedOs): string {
  switch (os) {
    case 'macos':
      // "Mac", not "macOS": this is a button, and the shorter word reads
      // better at every size. The dropdown row stays "macOS (Apple Silicon)"
      // where the precision earns its length.
      return 'Download for Mac';
    case 'windows':
      return 'Download for Windows';
    case 'linux':
      return 'Download for Linux';
    default:
      return 'Download';
  }
}

/**
 * The `?os=&arch=&format=` triple identifying a target to the redirect routes.
 * Emitted as a fragment (no leading `?`) so callers can append it to a URL
 * that already carries `utm_content`.
 */
export function targetQuery(target: DownloadTarget): string {
  return `os=${target.os}&arch=${target.arch}&format=${target.format}`;
}

/** Tracked `/download/stable` URL for one build, attributed to one CTA. */
export function downloadHrefForTarget(cta: DownloadCta, target: DownloadTarget): string {
  return `${downloadRouteForCta(cta)}&${targetQuery(target)}`;
}

/**
 * Resolve the target a redirect route was asked for. Returns null when the
 * triple names no published build — including the no-params case, which is
 * every pre-picker link still in the wild — so callers apply their own
 * fallback rather than inheriting one from here.
 */
export function resolveTargetFromParams(params: URLSearchParams): DownloadTarget | null {
  const os = params.get('os');
  const arch = params.get('arch');
  const format = params.get('format');
  if (!os) return null;
  return (
    DOWNLOAD_TARGETS.find(
      (target) =>
        target.os === os &&
        // Arch and format are optional: `?os=windows` alone is a legacy link
        // shape, and it should still land on that OS's default build.
        (arch === null || target.arch === arch) &&
        (format === null || target.format === format),
    ) ?? (isDownloadOs(os) ? targetById(DEFAULT_TARGET_BY_OS[os]) : null)
  );
}

function isDownloadOs(value: string): value is DownloadOs {
  return value === 'macos' || value === 'windows' || value === 'linux';
}
