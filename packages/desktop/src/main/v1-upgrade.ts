import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SyncMode } from '@inkeep/open-knowledge-core';
import type { OkV1UpgradeSnapshot } from '@inkeep/open-knowledge-core/desktop-bridge';
import type { UpdateChannel } from './state-store.ts';
import { resolveRootAutoSyncMode } from './worktree-autosync-inherit.ts';

export const V1_MANUAL_DOWNLOAD_URL = 'https://openknowledge.ai/download';
export const V1_MIGRATION_GUIDE_URL = 'https://openknowledge.ai/updates/v1-guide';
export const V1_RELEASE_NOTES_URL = 'https://openknowledge.ai/updates/v1-notes';
const V1_PROBE_TIMEOUT_MS = 5_000;

const MAX_RECENT_PROJECTS_TO_SCAN = 20;
const MAX_OKIGNORE_PROJECTS = 5;
const LOCATION_VERSION_RE = /(?:^|\/)v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\/|$)/;
const MAJOR_VERSION_RE = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type V1ChannelSlug = 'v1-stable' | 'v1-beta' | 'v1-beta-product';

export interface V1UpgradeFeedTarget {
  readonly channelSlug: V1ChannelSlug;
  readonly feedUrl: string;
  readonly manifestUrl: string;
}

export type V1ProbeResult =
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'dormant' }
  | { readonly kind: 'error'; readonly reason: string };

interface V1ProbeResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}

export type V1ProbeFetch = (url: string, init?: RequestInit) => Promise<V1ProbeResponseLike>;

export interface V1ImpactDeps {
  readonly existsSync: (path: string) => boolean;
  readonly resolveAutoSyncMode: (projectPath: string) => SyncMode | null;
}

const DEFAULT_IMPACT_DEPS: V1ImpactDeps = {
  existsSync,
  resolveAutoSyncMode: resolveRootAutoSyncMode,
};

function majorOf(version: string): number | null {
  const match = MAJOR_VERSION_RE.exec(version);
  return match ? Number(match[1]) : null;
}

function v1ManifestSuffix(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return '-mac.yml';
  if (platform === 'win32') return '.yml';
  if (platform === 'linux' && arch === 'arm64') return '-linux-arm64.yml';
  return '-linux.yml';
}

export function resolveV1UpgradeFeed(opts: {
  proxyFeed?: {
    base: string;
    channels: ReadonlySet<UpdateChannel>;
    betaChannel?: 'beta' | 'beta-product';
  };
  buildChannel: UpdateChannel;
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
}): V1UpgradeFeedTarget | null {
  const { proxyFeed, buildChannel, platform, arch, appVersion } = opts;
  if (!proxyFeed?.channels.has(buildChannel)) return null;
  const currentMajor = majorOf(appVersion);
  if (currentMajor !== null && currentMajor >= 1) return null;

  const base = proxyFeed.base.replace(/\/+$/, '');
  const suffix = v1ManifestSuffix(platform, arch);
  const proxyChannelPath = buildChannel === 'beta' ? (proxyFeed.betaChannel ?? 'beta') : 'stable';
  const channelSlug: V1ChannelSlug = `v1-${proxyChannelPath}`;
  const manifestPrefix = proxyChannelPath === 'stable' ? 'latest' : proxyChannelPath;

  return {
    channelSlug,
    feedUrl: `${base}/${channelSlug}`,
    manifestUrl: `${base}/${channelSlug}/${manifestPrefix}${suffix}`,
  };
}

export function parseV1VersionFromLocation(location: string | null): string | null {
  if (!location) return null;
  const match = LOCATION_VERSION_RE.exec(location);
  const version = match?.[1];
  if (!version) return null;
  const major = majorOf(version);
  if (major === null || major < 1) return null;
  return version;
}

export async function probeV1UpgradeVersion(
  manifestUrl: string,
  fetchImpl: V1ProbeFetch = fetch,
  timeoutMs: number = V1_PROBE_TIMEOUT_MS,
): Promise<V1ProbeResult> {
  try {
    const response = await fetchImpl(manifestUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      return { kind: 'dormant' };
    }
    if (response.status !== 302) {
      return { kind: 'error', reason: `http-${response.status}` };
    }
    const version = parseV1VersionFromLocation(response.headers.get('location'));
    if (!version) {
      return { kind: 'error', reason: 'unparseable-location' };
    }
    return { kind: 'available', version };
  } catch (err) {
    return {
      kind: 'error',
      reason: err instanceof Error && err.message ? err.message : String(err),
    };
  }
}

export function scanV1UpgradeImpact(
  recentProjects: readonly {
    readonly path: string;
    readonly name: string;
    readonly gitRemoteUrl?: string;
  }[],
  deps: V1ImpactDeps = DEFAULT_IMPACT_DEPS,
): { readonly okignoreProjects: readonly string[]; readonly hasGitProjects: boolean } {
  const okignoreProjects: string[] = [];
  const seenNames = new Set<string>();
  let hasGitProjects = false;

  const bounded = recentProjects.slice(0, MAX_RECENT_PROJECTS_TO_SCAN);
  for (const project of bounded) {
    if (!project.path) continue;
    if (typeof project.gitRemoteUrl === 'string' && project.gitRemoteUrl.length > 0) {
      hasGitProjects = true;
    } else if (!hasGitProjects) {
      const mode = deps.resolveAutoSyncMode(project.path);
      if (mode === 'follow' || mode === 'full') {
        hasGitProjects = true;
      }
    }

    if (okignoreProjects.length < MAX_OKIGNORE_PROJECTS) {
      if (deps.existsSync(join(project.path, '.okignore'))) {
        const label = project.name.trim() || basename(project.path) || project.path;
        if (!seenNames.has(label)) {
          seenNames.add(label);
          okignoreProjects.push(label);
        }
      }
    }
  }

  return { okignoreProjects, hasGitProjects };
}

export function buildDormantV1UpgradeSnapshot(opts?: {
  proactiveAllowed?: boolean;
  toastDismissed?: boolean;
  canInstallInApp?: boolean;
  autoInstallOnAppQuit?: boolean;
}): OkV1UpgradeSnapshot {
  return {
    availableVersion: null,
    proactiveAllowed: opts?.proactiveAllowed ?? false,
    toastDismissed: opts?.toastDismissed ?? false,
    canInstallInApp: opts?.canInstallInApp ?? false,
    autoInstallOnAppQuit: opts?.autoInstallOnAppQuit ?? false,
    phase: 'idle',
    progressPercent: null,
    errorCode: null,
    okignoreProjects: [],
    hasGitProjects: false,
    manualDownloadUrl: V1_MANUAL_DOWNLOAD_URL,
    migrationGuideUrl: V1_MIGRATION_GUIDE_URL,
    releaseNotesUrl: V1_RELEASE_NOTES_URL,
  };
}
