import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  readFileSync as fsReadFileSync,
  readlinkSync as fsReadlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export const PATH_SHIM_BEGIN = '# >>> open-knowledge cli >>>';
export const PATH_SHIM_END = '# <<< open-knowledge cli <<<';
export const PATH_SHIM_BLOCK_RE =
  /^# >>> open-knowledge cli >>>\n[\s\S]*?^# <<< open-knowledge cli <<<\n?/m;

export interface PathDiscovery {
  capturedAt: string;
  pathEntries: string[];
  shellUsed: string;
  okBinAlreadyOnPath: boolean;
}

export interface PathInstallConsent {
  status: 'granted' | 'declined';
  at: string;
}

export interface PathInstallMarker {
  version: 1;
  installedAt: string;
  bundleVersion: string;
  bundleWrapperPath: string;
  binDir: string;
  envShimPath: string;
  rcFiles: string[];
  rcOptOuts: string[];
  pathDiscovery: PathDiscovery | null;
  extraSymlinks: Array<{
    path: string;
    target: string;
    createdAt: string;
    kind: 'created' | 'refreshed-our-own';
  }>;
  consent?: PathInstallConsent;
}

export function pathInstallMarkerPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json');
}

export interface PathShimFsOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync(path: string): { isSymbolicLink(): boolean };
  readlinkSync(path: string): string;
}

const defaultFsOps: PathShimFsOps = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
  lstatSync: (path) => fsLstatSync(path),
  readlinkSync: (path) => fsReadlinkSync(path),
};

export function readPathInstallMarker(
  home: string,
  fs: PathShimFsOps = defaultFsOps,
): PathInstallMarker | null {
  const path = pathInstallMarkerPath(home);
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as PathInstallMarker;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function stripManagedPathBlock(text: string): {
  text: string;
  changed: boolean;
  emptyAfter: boolean;
} {
  const next = text.replace(PATH_SHIM_BLOCK_RE, '');
  return { text: next, changed: next !== text, emptyAfter: next.trim() === '' };
}

export function extraSymlinkStillOurs(
  path: string,
  target: string,
  fs: PathShimFsOps = defaultFsOps,
): boolean {
  try {
    if (!fs.lstatSync(path).isSymbolicLink()) return false;
    return fs.readlinkSync(path) === target;
  } catch {
    return false;
  }
}
