import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// WARN: packages/app ships this page as public/assets/preview-frame.html and loads it from preview-iframe-header.ts; keep the paths in step.
const PREVIEW_FRAME_FILE = 'assets/preview-frame.html';

const PREVIEW_FRAME_CSP = "sandbox allow-scripts; frame-ancestors 'self'";

const INLINE_SCRIPT = /<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

function appShellContentSecurityPolicy(html: string): string {
  const scriptHashes = [...html.matchAll(INLINE_SCRIPT)].map(
    (match) =>
      `'sha256-${createHash('sha256')
        .update(match[1] ?? '')
        .digest('base64')}'`,
  );
  return [
    ["script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'", ...scriptHashes].join(' '),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

const NO_INLINE_SCRIPT_POLICY = appShellContentSecurityPolicy('');

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const RECENT_CHANGE_MS = 2_000;

interface BundleListing {
  documents: string[];
  folders: Map<string, number>;
  settled: boolean;
}

function listBundle(root: string): BundleListing {
  const listedAt = Date.now();
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  const folders = [
    root,
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name)),
  ];
  const folderMtimes = new Map(folders.map((folder) => [folder, statSync(folder).mtimeMs]));
  const recentFrom = listedAt - RECENT_CHANGE_MS;
  const recentUntil = Date.now() + RECENT_CHANGE_MS;
  return {
    documents: entries
      .filter((entry) => entry.isFile() && HTML_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => join(entry.parentPath, entry.name)),
    folders: folderMtimes,
    settled: ![...folderMtimes.values()].some(
      (mtimeMs) => mtimeMs >= recentFrom && mtimeMs <= recentUntil,
    ),
  };
}

function folderChanged([folder, mtimeMs]: [string, number]): boolean {
  try {
    return statSync(folder).mtimeMs !== mtimeMs;
  } catch {
    return true;
  }
}

function fileIdentity(stats: Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs].join(':');
}

function currentIdentity(file: string): string | undefined {
  try {
    return fileIdentity(statSync(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export interface AppShellPolicyFailure {
  err: unknown;
  root: string;
  file?: string;
}

export function createAppShellPolicies(
  bundleDir: string,
  onFailure: (failure: AppShellPolicyFailure, message: string) => void,
): (served: Stats, servedPath?: string) => string | undefined {
  const root = resolve(bundleDir);
  const previewFrame = resolve(root, PREVIEW_FRAME_FILE);
  let listing: BundleListing | undefined;
  const policies = new Map<string, { mtimeMs: number; policy: string }>();

  function currentListing(): BundleListing {
    if (listing === undefined || !listing.settled || [...listing.folders].some(folderChanged)) {
      listing = listBundle(root);
    }
    return listing;
  }

  function servedDocument(served: Stats): string | undefined {
    const identity = fileIdentity(served);
    const matches = currentListing().documents.filter((file) => currentIdentity(file) === identity);
    if (matches.length > 1) {
      throw new Error(`the served file matches more than one document: ${matches.join(', ')}`);
    }
    return matches[0];
  }

  function documentPolicy(file: string, mtimeMs: number): string {
    const cached = policies.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.policy;
    try {
      const policy = appShellContentSecurityPolicy(readFileSync(file, 'utf8'));
      policies.set(file, { mtimeMs, policy });
      return policy;
    } catch (err) {
      onFailure(
        { err, root, file },
        'could not read an app shell document; serving it with a policy that allows no inline script',
      );
      return NO_INLINE_SCRIPT_POLICY;
    }
  }

  return (served, servedPath) => {
    let file: string | undefined;
    try {
      file = servedDocument(served);
    } catch (err) {
      onFailure(
        { err, root, file: servedPath },
        'could not identify the app shell file being served; sending a policy that allows no inline script',
      );
      return NO_INLINE_SCRIPT_POLICY;
    }
    if (file === undefined) return undefined;
    return file === previewFrame ? PREVIEW_FRAME_CSP : documentPolicy(file, served.mtimeMs);
  };
}
