
import { SITE_NAME } from './site';

const SHARE_URL_VERSION_V1 = 0x01;

interface DecodedShare {
  version: number;
  sharedUrl: string;
}

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
  const cleaned = encoded.split(/[?#]/)[0];
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

  return { version, sharedUrl };
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

export interface ParsedGitHubBlobUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface ParsedGitHubTreeUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export type ParsedGitHubShareTarget =
  | { kind: 'doc'; owner: string; repo: string; branch: string; path: string }
  | { kind: 'folder'; owner: string; repo: string; branch: string; path: string };

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

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null;
  }

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

  return { owner, repo, branch, path: pathParts.join('/') };
}

function parseGitHubTreeUrl(input: string): ParsedGitHubTreeUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null;
  }

  const rawSegments = url.pathname.split('/');

  if (rawSegments.length < 5) return null;
  if (rawSegments[0] !== '') return null; // leading-slash hygiene
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

  return { owner, repo, branch, path: pathParts.join('/') };
}

function parseGitHubShareUrl(input: string): ParsedGitHubShareTarget | null {
  const blob = parseGitHubBlobUrl(input);
  if (blob) return { kind: 'doc', ...blob };

  const tree = parseGitHubTreeUrl(input);
  if (tree) return { kind: 'folder', ...tree };

  return null;
}

export { DOWNLOAD_URL as SPLASH_DOWNLOAD_URL } from './site';

export function buildCustomSchemeUrl(sharedUrl: string): string {
  return `openknowledge://share?url=${encodeURIComponent(sharedUrl)}`;
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

export type SplashOs = 'macos' | 'linux' | 'windows' | 'unknown';

export function classifySplashOs(input: string | null | undefined): SplashOs {
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

export interface SplashCtaLayout {
  showWindowsNotice: boolean;
  showCluster: boolean;
  cliInline: boolean;
  showStandaloneGithub: boolean;
}

export function splashCtaLayout(os: SplashOs): SplashCtaLayout {
  if (os === 'windows') {
    return {
      showWindowsNotice: true,
      showCluster: false,
      cliInline: false,
      showStandaloneGithub: false,
    };
  }
  if (os === 'linux') {
    return {
      showWindowsNotice: false,
      showCluster: false,
      cliInline: true,
      showStandaloneGithub: true,
    };
  }
  return {
    showWindowsNotice: false,
    showCluster: true,
    cliInline: false,
    showStandaloneGithub: false,
  };
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
    return { kind: 'invalid' };
  }

  const parsed = parseGitHubShareUrl(decoded.sharedUrl);
  if (!parsed) {
    return { kind: 'invalid' };
  }

  const { kind, owner, repo, branch, path } = parsed;
  const segments = path.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  const filename = basename ?? repo;

  return {
    kind: 'ok',
    target: kind,
    filename,
    owner,
    repo,
    repoPath: `${owner}/${repo}`,
    branch,
    isDefaultBranch: isCommonDefaultBranch(branch),
    sharedUrl: decoded.sharedUrl,
    customSchemeUrl: buildCustomSchemeUrl(decoded.sharedUrl),
    githubUrl: decoded.sharedUrl,
  };
}

export function buildShareDescription(view: Extract<SplashView, { kind: 'ok' }>): string {
  const noun = view.target === 'folder' ? 'folder' : 'document';
  const branchSuffix = view.isDefaultBranch ? '' : ` (on ${view.branch})`;
  return `Open ${view.filename} with ${SITE_NAME} — a shared ${noun} from ${view.repoPath}${branchSuffix}.`;
}
