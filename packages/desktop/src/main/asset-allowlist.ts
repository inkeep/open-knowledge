import { realpathSync, statSync } from 'node:fs';
import * as pathPosix from 'node:path/posix';
import * as pathWin32 from 'node:path/win32';
import { EXECUTABLE_BLOCKLIST_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isPathWithinProject } from './ipc-handlers.ts';

export type AssetOpenResult =
  | { ok: true }
  | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' };

type AssetRevealResult =
  | { ok: true }
  | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' };

export function extractPathExtension(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? path.slice(lastSep + 1) : path;
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return basename.slice(dotIdx + 1).toLowerCase();
}

interface OpenAssetDeps {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly openPath: (canonical: string) => Promise<string>;
  readonly resolveCanonical?: (path: string) => string;
  readonly statExists?: (path: string) => boolean;
}

interface RevealAssetDeps {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly showItemInFolder: (canonical: string) => void;
  readonly resolveCanonical?: (path: string) => string;
  readonly statExists?: (path: string) => boolean;
}

function resolveAndContain(
  relPath: string,
  projectPath: string,
  platform: NodeJS.Platform,
  resolveCanonical: (path: string) => string,
  statExists: (path: string) => boolean,
):
  | { ok: true; canonical: string }
  | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' } {
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  if (p.isAbsolute(relPath)) {
    return { ok: false, reason: 'path-escape' };
  }

  const joined = p.resolve(projectPath, relPath);

  let canonical: string;
  try {
    canonical = resolveCanonical(joined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'resolve-error' };
  }

  if (!isPathWithinProject(canonical, projectPath, platform)) {
    return { ok: false, reason: 'path-escape' };
  }

  if (!statExists(canonical)) {
    return { ok: false, reason: 'not-found' };
  }

  return { ok: true, canonical };
}

function defaultResolveCanonical(path: string): string {
  return realpathSync(path);
}

function defaultStatExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function openAssetSafely(
  deps: OpenAssetDeps,
  relPath: string,
): Promise<AssetOpenResult> {
  const resolveCanonical = deps.resolveCanonical ?? defaultResolveCanonical;
  const statExists = deps.statExists ?? defaultStatExists;

  const contained = resolveAndContain(
    relPath,
    deps.projectPath,
    deps.platform,
    resolveCanonical,
    statExists,
  );
  if (!contained.ok) return contained;

  const ext = extractPathExtension(contained.canonical);
  if (EXECUTABLE_BLOCKLIST_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'extension-blocked' };
  }

  const osError = await deps.openPath(contained.canonical);
  if (osError !== '') {
    return { ok: false, reason: 'resolve-error' };
  }
  return { ok: true };
}

export async function revealAssetSafely(
  deps: RevealAssetDeps,
  relPath: string,
): Promise<AssetRevealResult> {
  const resolveCanonical = deps.resolveCanonical ?? defaultResolveCanonical;
  const statExists = deps.statExists ?? defaultStatExists;

  const contained = resolveAndContain(
    relPath,
    deps.projectPath,
    deps.platform,
    resolveCanonical,
    statExists,
  );
  if (!contained.ok) return contained;

  deps.showItemInFolder(contained.canonical);
  return { ok: true };
}
