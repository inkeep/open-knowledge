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

export type DetectedOs = 'macos' | 'windows' | 'linux' | 'unknown';

type DownloadOs = Exclude<DetectedOs, 'unknown'>;

type DownloadArch = 'arm64' | 'x64';

type DownloadFormat = 'dmg' | 'exe' | 'deb' | 'rpm';

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
  label: string;
  assetUrl: string;
}

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

const DEFAULT_TARGET_BY_OS: Record<DownloadOs, DownloadTargetId> = {
  macos: 'macos-arm64',
  windows: 'windows-x64',
  linux: 'linux-deb-x64',
};

const FALLBACK_TARGET_ID: DownloadTargetId = 'macos-arm64';

const DOWNLOAD_PAGE_ORIGIN = 'https://openknowledge.ai';

export const DOWNLOAD_PAGE_HREF = `${DOWNLOAD_PAGE_ORIGIN}/download`;

export function downloadPageHrefForCta(cta: DownloadCta): string {
  return `${DOWNLOAD_PAGE_HREF}?utm_content=${encodeURIComponent(cta)}`;
}

export const WEB_APP_HREF = '/docs/reference/cli';

export const WEB_APP_LABEL = 'Run in your browser (npm)';

export function targetById(id: DownloadTargetId): DownloadTarget {
  const target = DOWNLOAD_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown download target: ${id}`);
  return target;
}

export function defaultTargetForOs(os: DetectedOs): DownloadTarget {
  return targetById(os === 'unknown' ? FALLBACK_TARGET_ID : DEFAULT_TARGET_BY_OS[os]);
}

export function orderTargetsForOs(os: DetectedOs): readonly DownloadTarget[] {
  if (os === 'unknown') return DOWNLOAD_TARGETS;
  return [
    ...DOWNLOAD_TARGETS.filter((target) => target.os === os),
    ...DOWNLOAD_TARGETS.filter((target) => target.os !== os),
  ];
}

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
    lower.includes('chrome os') ||
    lower.includes('chromium os')
  ) {
    return 'linux';
  }
  return 'unknown';
}

export function readPlatformInput(): string | null {
  if (typeof navigator === 'undefined') return null;
  const withUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return withUaData.userAgentData?.platform ?? navigator.userAgent ?? null;
}

export function downloadLabelForOs(os: DetectedOs): string {
  switch (os) {
    case 'macos':
      return 'Download for Mac';
    case 'windows':
      return 'Download for Windows';
    case 'linux':
      return 'Download for Linux';
    default:
      return 'Download';
  }
}

export function targetQuery(target: DownloadTarget): string {
  return `os=${target.os}&arch=${target.arch}&format=${target.format}`;
}

export function downloadHrefForTarget(cta: DownloadCta, target: DownloadTarget): string {
  return `${downloadRouteForCta(cta)}&${targetQuery(target)}`;
}

export function downloadHrefForDetectedOs(cta: DownloadCta, os: DetectedOs): string {
  if (os === 'windows' || os === 'linux') return downloadPageHrefForCta(cta);
  return downloadHrefForTarget(cta, defaultTargetForOs(os));
}

export function resolveTargetFromParams(params: URLSearchParams): DownloadTarget | null {
  const os = params.get('os');
  const arch = params.get('arch');
  const format = params.get('format');
  if (!os) return null;
  return (
    DOWNLOAD_TARGETS.find(
      (target) =>
        target.os === os &&
        (arch === null || target.arch === arch) &&
        (format === null || target.format === format),
    ) ?? (isDownloadOs(os) ? targetById(DEFAULT_TARGET_BY_OS[os]) : null)
  );
}

function isDownloadOs(value: string): value is DownloadOs {
  return value === 'macos' || value === 'windows' || value === 'linux';
}
