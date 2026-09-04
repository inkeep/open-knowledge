import { classifyGitHubShareHost } from '@inkeep/open-knowledge-core';

interface ParsedGitUrl {
  protocol: 'https' | 'ssh' | 'git';
  hostname: string;
  owner: string;
  name: string;
}

export interface ParsedGitHubBlobUrl {
  host: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface ParsedGitHubTreeUrl {
  host: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export type ParsedGitHubShareTarget =
  | { kind: 'doc'; host: string; owner: string; repo: string; branch: string; path: string }
  | { kind: 'folder'; host: string; owner: string; repo: string; branch: string; path: string };

function stripPort(hostname: string): string {
  return hostname.replace(/:\d+$/, '');
}

export function parseGitUrl(input: string): ParsedGitUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  {
    const m = /^https?:\/\/(?:[^/?#]*@)?([^@/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
      raw,
    );
    if (m) return { protocol: 'https', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  {
    const m = /^ssh:\/\/(?:[^/?#]*@)?([^@/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
      raw,
    );
    if (m) return { protocol: 'ssh', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  {
    const m = /^git:\/\/([^/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) return { protocol: 'git', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  {
    const m = /^(?:[\w.\-~%]+@)?([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
    if (m?.[1].includes('.')) {
      return { protocol: 'ssh', hostname: m[1], owner: m[2], name: m[3] };
    }
    if (m && raw.startsWith('git@')) {
      return { protocol: 'ssh', hostname: m[1], owner: m[2], name: m[3] };
    }
  }

  {
    const m = /^git:([\w.-]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) return { protocol: 'git', hostname: m[1], owner: m[2], name: m[3] };
  }

  if (!raw.includes('://') && !raw.includes('@') && !raw.startsWith('/')) {
    const m = /^([\w.-]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
    if (m) return { protocol: 'https', hostname: 'github.com', owner: m[1], name: m[2] };
  }

  return null;
}

export function parseGitHubBlobUrl(input: string): ParsedGitHubBlobUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;

  const host = classifyGitHubShareHost(url.hostname);
  if (host === null) return null;

  const rawSegments = url.pathname.split('/').filter((s) => s.length > 0);

  if (rawSegments.length < 5) return null;
  if (rawSegments[2] !== 'blob') return null;

  let owner: string;
  let repo: string;
  let branch: string;
  let pathParts: string[];
  try {
    owner = decodeURIComponent(rawSegments[0]);
    repo = decodeURIComponent(rawSegments[1]);
    branch = decodeURIComponent(rawSegments[3]);
    pathParts = rawSegments.slice(4).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }

  if (!owner || !repo || !branch || pathParts.length === 0) return null;
  if (pathParts.some((p) => p.length === 0)) return null;

  return { host, owner, repo, branch, path: pathParts.join('/') };
}

export function parseGitHubTreeUrl(input: string): ParsedGitHubTreeUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;

  const host = classifyGitHubShareHost(url.hostname);
  if (host === null) return null;

  const rawSegments = url.pathname.split('/');

  if (rawSegments.length < 5) return null;
  if (rawSegments[0] !== '') return null;
  if (rawSegments[3] !== 'tree') return null;

  const pathSegmentsRaw = rawSegments.slice(5);
  if (pathSegmentsRaw.length === 1 && pathSegmentsRaw[0] === '') pathSegmentsRaw.pop();

  let owner: string;
  let repo: string;
  let branch: string;
  let pathParts: string[];
  try {
    owner = decodeURIComponent(rawSegments[1]);
    repo = decodeURIComponent(rawSegments[2]);
    branch = decodeURIComponent(rawSegments[4]);
    pathParts = pathSegmentsRaw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }

  if (!owner || !repo || !branch) return null;
  if (pathParts.some((p) => p.length === 0)) return null;

  return { host, owner, repo, branch, path: pathParts.join('/') };
}

export function parseGitHubShareUrl(input: string): ParsedGitHubShareTarget | null {
  const blob = parseGitHubBlobUrl(input);
  if (blob) return { kind: 'doc', ...blob };

  const tree = parseGitHubTreeUrl(input);
  if (tree) return { kind: 'folder', ...tree };

  return null;
}
