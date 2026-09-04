import {
  classifyDownloadOs,
  type DetectedOs,
  defaultTargetForOs,
  targetQuery,
} from './download-targets';
import { SITE_NAME } from './site';

const SHARE_URL_VERSION_V1 = 0x01;
const SHARE_URL_VERSION_V2 = 0x02;
const V2_HEADER_BYTES = 3;
const MAX_V2_SHARE_TOKEN_CHARS = 3984;
const MAX_V2_SHARE_PAYLOAD_BYTES = 2988;
const MAX_V2_SHARED_URL_UTF8_BYTES = 2985;
const IPV4_AUTHORITY_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

interface CanonicalGitHubShareSource {
  host: string;
  owner: string;
  repo: string;
  branch: string;
  kind: 'doc' | 'folder';
  targetSegments: string[];
}

type DecodedShare =
  | { version: 1; sharedUrl: string }
  | {
      version: 2;
      sharedUrl: string;
      contentRootDepth: number;
      source: CanonicalGitHubShareSource;
      targetPath: string;
    };

class UnsupportedShareVersionError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`Unsupported share URL version: 0x${version.toString(16).padStart(2, '0')}`);
    this.name = 'UnsupportedShareVersionError';
    this.version = version;
  }
}

class InvalidShareUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidShareUrlError';
  }
}

function decodeShareUrl(encoded: string): DecodedShare {
  const peekedVersion = peekBase64UrlVersion(encoded);
  if (peekedVersion === SHARE_URL_VERSION_V2 && encoded.length > MAX_V2_SHARE_TOKEN_CHARS) {
    throw new InvalidShareUrlError('Invalid v2 share token');
  }

  const suffixIndex = encoded.search(/[?#]/);
  if (peekedVersion === SHARE_URL_VERSION_V2) {
    if (suffixIndex !== -1) throw new InvalidShareUrlError('Invalid v2 share token');
    return decodeV2ShareUrl(encoded);
  }

  const cleaned = suffixIndex === -1 ? encoded : encoded.slice(0, suffixIndex);
  if (cleaned.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToUint8Array(cleaned);
  } catch {
    throw new InvalidShareUrlError('Share payload is not valid base64url');
  }

  if (bytes.length === 0) {
    throw new InvalidShareUrlError('Share payload is empty');
  }

  const version = bytes[0];
  if (version !== SHARE_URL_VERSION_V1) {
    throw new UnsupportedShareVersionError(version);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sharedUrl: string;
  try {
    sharedUrl = decoder.decode(bytes.subarray(1));
  } catch {
    throw new InvalidShareUrlError('Share payload body is not valid UTF-8');
  }

  return { version: 1, sharedUrl };
}

function decodeV2ShareUrl(encoded: string): DecodedShare {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToUint8Array(encoded);
  } catch {
    throw new InvalidShareUrlError('Share payload is not valid base64url');
  }
  if (
    bytes.length <= V2_HEADER_BYTES ||
    bytes.length > MAX_V2_SHARE_PAYLOAD_BYTES ||
    uint8ArrayToBase64Url(bytes) !== encoded
  ) {
    throw new InvalidShareUrlError('Invalid v2 share framing');
  }
  const contentRootDepth = (bytes[1] << 8) | bytes[2];
  if (contentRootDepth < 1) throw new InvalidShareUrlError('Invalid content root depth');
  const urlBytes = bytes.subarray(V2_HEADER_BYTES);
  if (urlBytes.length > MAX_V2_SHARED_URL_UTF8_BYTES) {
    throw new InvalidShareUrlError('Share URL exceeds the v2 limit');
  }
  let sharedUrl: string;
  try {
    sharedUrl = new TextDecoder('utf-8', { fatal: true }).decode(urlBytes);
  } catch {
    throw new InvalidShareUrlError('Share payload body is not valid UTF-8');
  }
  const source = parseCanonicalGitHubShareUrl(sharedUrl);
  if (contentRootDepth > source.targetSegments.length) {
    throw new InvalidShareUrlError('Content root depth exceeds the target');
  }
  const targetPath = source.targetSegments.slice(contentRootDepth).join('/');
  if (source.kind === 'doc' && targetPath === '') {
    throw new InvalidShareUrlError('Document target cannot be the content root');
  }
  return { version: 2, sharedUrl, contentRootDepth, source, targetPath };
}

function parseCanonicalGitHubShareUrl(sharedUrl: string): CanonicalGitHubShareSource {
  if (!sharedUrl.startsWith('https://') || sharedUrl.includes('?') || sharedUrl.includes('#')) {
    throw new InvalidShareUrlError('Share URL is not canonical HTTPS');
  }
  const authorityAndPath = sharedUrl.slice('https://'.length);
  const pathStart = authorityAndPath.indexOf('/');
  if (pathStart <= 0) throw new InvalidShareUrlError('Share URL is missing a repository path');
  const host = authorityAndPath.slice(0, pathStart);
  const hostLabels = host.split('.');
  if (
    host.length > 253 ||
    host !== host.toLowerCase() ||
    host.endsWith('.') ||
    host.includes(':') ||
    IPV4_AUTHORITY_PATTERN.test(host) ||
    hostLabels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) ||
    classifyGitHubShareHost(host) !== host
  ) {
    throw new InvalidShareUrlError('Share URL host is not canonical');
  }
  const rawSegments = authorityAndPath.slice(pathStart + 1).split('/');
  if (rawSegments.length < 4 || rawSegments.some((segment) => segment === '')) {
    throw new InvalidShareUrlError('Share URL path is invalid');
  }
  const [rawOwner, rawRepo, rawKind, rawBranch, ...rawTarget] = rawSegments;
  if (rawKind !== 'blob' && rawKind !== 'tree') {
    throw new InvalidShareUrlError('Share URL kind is invalid');
  }
  const owner = decodeCanonicalComponent(rawOwner);
  const repo = decodeCanonicalComponent(rawRepo);
  const branch = decodeCanonicalComponent(rawBranch);
  const targetSegments = rawTarget.map(decodeCanonicalComponent);
  if (!isShareSegmentSafe(owner, repo, branch)) {
    throw new InvalidShareUrlError('Share URL repository identity is invalid');
  }
  for (const component of [owner, repo, ...targetSegments]) assertCanonicalPathComponent(component);
  const kind = rawKind === 'blob' ? 'doc' : 'folder';
  if (kind === 'doc' && targetSegments.length === 0) {
    throw new InvalidShareUrlError('Document URL is missing its target');
  }
  const source = {
    host,
    owner,
    repo,
    branch,
    kind,
    targetSegments,
  } satisfies CanonicalGitHubShareSource;
  if (serializeCanonicalGitHubShareUrl(source) !== sharedUrl) {
    throw new InvalidShareUrlError('Share URL is not canonically serialized');
  }
  return source;
}

function decodeCanonicalComponent(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new InvalidShareUrlError('Malformed percent encoding');
  }
  if (encodeURIComponent(decoded) !== raw) {
    throw new InvalidShareUrlError('Non-canonical percent encoding');
  }
  return decoded;
}

function assertCanonicalPathComponent(component: string): void {
  if (
    component === '' ||
    component === '.' ||
    component === '..' ||
    component.toLowerCase() === '.git' ||
    component.includes('/') ||
    component.includes('\\') ||
    [...component].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f)
  ) {
    throw new InvalidShareUrlError('Invalid path component');
  }
}

function serializeCanonicalGitHubShareUrl(source: CanonicalGitHubShareSource): string {
  const kind = source.kind === 'doc' ? 'blob' : 'tree';
  return `https://${source.host}/${[
    source.owner,
    source.repo,
    kind,
    source.branch,
    ...source.targetSegments,
  ]
    .map(encodeURIComponent)
    .join('/')}`;
}

function peekBase64UrlVersion(input: string): number | null {
  if (input.length < 2) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const first = alphabet.indexOf(input[0]);
  const second = alphabet.indexOf(input[1]);
  if (first < 0 || second < 0) return null;
  return (first << 2) | (second >>> 4);
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('Input contains non-base64url characters');
  }
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

const KNOWN_NON_GITHUB_GIT_HOSTS = new Set([
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourcehut.org',
]);

function classifyGitHubShareHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  const folded = host === 'www.github.com' ? 'github.com' : host;
  return KNOWN_NON_GITHUB_GIT_HOSTS.has(folded) ? null : folded;
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

const SHARE_OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

function isValidShareBranch(branch: string): boolean {
  if (branch.length === 0) return false;
  if (branch.startsWith('-')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the intent
  if (/[\x00-\x1F\x7F]/.test(branch)) return false;
  if (/\s/.test(branch)) return false;
  if (branch.includes(':')) return false;
  if (branch.split('/').includes('..')) return false;
  return true;
}

function isShareSegmentSafe(owner: string, repo: string, branch: string): boolean {
  const nameSafe = (s: string) =>
    SHARE_OWNER_REPO_PATTERN.test(s) && !s.startsWith('-') && s !== '.' && s !== '..';
  return nameSafe(owner) && nameSafe(repo) && isValidShareBranch(branch);
}

function parseGitHubBlobUrl(input: string): ParsedGitHubBlobUrl | null {
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
  if (!isShareSegmentSafe(owner, repo, branch)) return null;

  return { host, owner, repo, branch, path: pathParts.join('/') };
}

function parseGitHubTreeUrl(input: string): ParsedGitHubTreeUrl | null {
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
  if (!isShareSegmentSafe(owner, repo, branch)) return null;

  return { host, owner, repo, branch, path: pathParts.join('/') };
}

function parseGitHubShareUrl(input: string): ParsedGitHubShareTarget | null {
  const blob = parseGitHubBlobUrl(input);
  if (blob) return { kind: 'doc', ...blob };

  const tree = parseGitHubTreeUrl(input);
  if (tree) return { kind: 'folder', ...tree };

  return null;
}

export { DOWNLOAD_URL as SPLASH_DOWNLOAD_URL } from './site';

export function buildCustomSchemeUrl(sharedUrl: string, token?: string): string {
  return token === undefined
    ? `openknowledge://share?url=${encodeURIComponent(sharedUrl)}`
    : `openknowledge://share?token=${token}`;
}

export const SPLASH_INSTALL_COMMAND = 'npm install -g @inkeep/open-knowledge';

function shellSingleQuoteShareArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const SHARE_SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/@+-]+$/;

function quoteShareArg(s: string): string {
  return SHARE_SHELL_SAFE_TOKEN.test(s) ? s : shellSingleQuoteShareArg(s);
}

export function buildCloneCommand({
  owner,
  repo,
  branch,
}: {
  owner: string;
  repo: string;
  branch: string;
}): string {
  return `ok clone ${quoteShareArg(owner)}/${quoteShareArg(repo)} -b ${quoteShareArg(branch)}`;
}

export type SplashOs = DetectedOs;
export const classifySplashOs = classifyDownloadOs;

export function splashDownloadQuery(os: SplashOs): string {
  return `?${targetQuery(defaultTargetForOs(os))}`;
}

export type ClipboardCopyOutcome = { kind: 'copied' } | { kind: 'fallback-select' };

export function clipboardCopyOutcome(succeeded: boolean): ClipboardCopyOutcome {
  return succeeded ? { kind: 'copied' } : { kind: 'fallback-select' };
}

function isCommonDefaultBranch(branch: string): boolean {
  return branch === 'main' || branch === 'master';
}

export type SplashView =
  | {
      kind: 'ok';
      target: 'doc' | 'folder';
      filename: string;
      host: string;
      isEnterpriseHost: boolean;
      owner: string;
      repo: string;
      repoPath: string;
      branch: string;
      isDefaultBranch: boolean;
      sharedUrl: string;
      customSchemeUrl: string;
      githubUrl: string;
    }
  | {
      kind: 'unsupported-version';
      version: number;
    }
  | { kind: 'invalid' };

export function buildSplashViewModel(encoded: string): SplashView {
  let decoded: DecodedShare;
  try {
    decoded = decodeShareUrl(encoded);
  } catch (err) {
    if (err instanceof UnsupportedShareVersionError) {
      return { kind: 'unsupported-version', version: err.version };
    }
    if (!(err instanceof InvalidShareUrlError)) {
      console.warn(
        `[share-splash] unexpected share-decode error (errorKind: ${
          err instanceof Error ? err.name : typeof err
        })`,
      );
    }
    return { kind: 'invalid' };
  }

  const parsed =
    decoded.version === 2
      ? {
          kind: decoded.source.kind,
          host: decoded.source.host,
          owner: decoded.source.owner,
          repo: decoded.source.repo,
          branch: decoded.source.branch,
          path: decoded.targetPath,
        }
      : parseGitHubShareUrl(decoded.sharedUrl);
  if (!parsed) {
    return { kind: 'invalid' };
  }

  const { kind, host, owner, repo, branch, path } = parsed;
  const segments = path.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  const filename = basename ?? repo;

  return {
    kind: 'ok',
    target: kind,
    filename,
    host,
    isEnterpriseHost: host !== 'github.com',
    owner,
    repo,
    repoPath: `${owner}/${repo}`,
    branch,
    isDefaultBranch: isCommonDefaultBranch(branch),
    sharedUrl: decoded.sharedUrl,
    customSchemeUrl: buildCustomSchemeUrl(
      decoded.sharedUrl,
      decoded.version === 2 ? encoded : undefined,
    ),
    githubUrl: decoded.sharedUrl,
  };
}

export function buildShareDescription(view: Extract<SplashView, { kind: 'ok' }>): string {
  const noun = view.target === 'folder' ? 'folder' : 'document';
  const branchSuffix = view.isDefaultBranch ? '' : ` (on ${view.branch})`;
  return `Open ${view.filename} with ${SITE_NAME} — a shared ${noun} from ${view.repoPath}${branchSuffix}.`;
}
