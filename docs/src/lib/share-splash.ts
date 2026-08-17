/**
 * Splash-local mirrors of the pure functions that live in the OK workspace:
 *
 *   - `decodeShareUrl` mirrors `packages/core/src/sharing/share-url.ts`
 *     (permanent v1 payload = `[0x01] || utf-8(<github-url>)`; canonical v2 =
 *     `[0x02] || uint16be(contentRootDepth) || utf-8(<github-url>)`)
 *   - `parseGitHubShareUrl` / `parseGitHubBlobUrl` / `parseGitHubTreeUrl`
 *     mirror `packages/cli/src/github/url.ts` — the dispatcher returns a
 *     kind-discriminated `{kind:'doc'|'folder', owner, repo, branch, path}`
 *     (blob → doc; tree → folder, whose path MAY be empty for the repo/branch
 *     root). Branch slashes must be percent-encoded.
 *
 * These stay copy-local instead of importing from
 * `@inkeep/open-knowledge-core` / `@inkeep/open-knowledge` so the static docs
 * build does NOT pull in the CRDT/markdown/Tiptap/CLI dependency tree. The
 * duplication is bounded and pinned by `share-splash.test.ts`. Any wire change
 * to the source modules (codec field names, URL-parser shapes) must be
 * mirrored here in lock-step, including strict v2 canonical parsing and its
 * token/payload/URL bounds.
 *
 * `buildSplashViewModel(encoded)` is the splash's single entry point — it
 * folds the decoder + dispatcher into a discriminated `SplashView` the route
 * uses to render the three states (ok / unsupported-version / invalid). The
 * `ok` view carries a `target` discriminator so the route can render a
 * file-vs-folder affordance.
 */

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

/**
 * Known non-GitHub forges — copy-local mirror of `KNOWN_NON_GITHUB_GIT_HOSTS`
 * in `@inkeep/open-knowledge-core` (kept inline so the static docs build has
 * no runtime dep on the package graph, per the file-header note). Any host not
 * listed is presumed github.com or a GitHub Enterprise Server instance.
 */
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

/**
 * Kind-discriminated share target. A GitHub blob URL is a `doc`; a GitHub tree
 * URL is a `folder` (whose `path` MAY be empty for the repo/branch root).
 */
export type ParsedGitHubShareTarget =
  | { kind: 'doc'; host: string; owner: string; repo: string; branch: string; path: string }
  | { kind: 'folder'; host: string; owner: string; repo: string; branch: string; path: string };

/**
 * Decode-boundary validation for the owner/repo/branch pulled out of a
 * github.com share URL — split across two layers:
 *
 *   - Structural validity (here): owner/repo must match GitHub's name charset;
 *     branch must satisfy the same ref contract the share/clone boundary
 *     enforces (`isValidBranchName` in `packages/core/src/schemas/api/share.ts`)
 *     — no leading `-`, no control chars, no whitespace, no `:`, no `..`
 *     segment. A ref the boundary accepts (e.g. `release+candidate`) must still
 *     render a usable receive page, so this mirrors that contract rather than a
 *     narrower allowlist that would reject valid shares.
 *   - Shell safety (at render): `buildCloneCommand` POSIX-single-quotes any
 *     segment outside a bare shell-safe token, so a ref carrying a shell
 *     metacharacter is inert in the copyable command. Validity is checked here;
 *     injection-safety is enforced where the command is built.
 *
 * Mirrors the core branch contract in lock-step — see the file header note on
 * why these helpers stay copy-local to the static docs build.
 */
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
  // Real GitHub owner/repo names are never `.` or `..`; rejecting them closes
  // the asymmetry with the branch `..` guard (a `github.com/../../blob/…` share
  // would otherwise render `ok clone ../.. …`).
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

  // Share links are always https. Reject any other scheme: a crafted deep
  // link could carry a non-https scheme (vscode:, ms-msdt:, …) with a valid
  // host and otherwise parse — that URL renders into an <a href> on this
  // public splash page.
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

/**
 * Parse a github.com `/tree/` (folder) URL. Unlike the blob parser, the folder
 * path MAY be empty — `tree/<branch>` and `tree/<branch>/` both denote the
 * repo/branch root and yield `path: ''`. Branch slashes must be
 * percent-encoded for the same disambiguation reason as the blob parser.
 */
function parseGitHubTreeUrl(input: string): ParsedGitHubTreeUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  // Share links are always https. Reject any other scheme: a crafted deep
  // link could carry a non-https scheme (vscode:, ms-msdt:, …) with a valid
  // host and otherwise parse — that URL renders into an <a href> on this
  // public splash page.
  if (url.protocol !== 'https:') return null;

  const host = classifyGitHubShareHost(url.hostname);
  if (host === null) return null;

  // Split WITHOUT filtering empties so empty intermediate path segments
  // (`a//b`) remain detectable. The pathname always starts with `/`, so
  // index 0 is the empty pre-owner segment.
  const rawSegments = url.pathname.split('/');

  // Expected shape: ['', owner, repo, 'tree', branch, ...pathSegments?]
  if (rawSegments.length < 5) return null;
  if (rawSegments[0] !== '') return null; // leading-slash hygiene
  if (rawSegments[3] !== 'tree') return null;

  // A single trailing-slash empty segment after the branch denotes the root
  // folder (`tree/<branch>/`); drop it so it isn't mistaken for a malformed
  // empty path segment.
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

/**
 * Dispatch a shared github.com URL to its target kind. A blob URL resolves to
 * a `doc`; a tree URL resolves to a `folder`. Blob is tried first because the
 * `/blob/` and `/tree/` prefixes are mutually exclusive. Returns null when the
 * input is neither a well-formed blob nor tree URL.
 */
function parseGitHubShareUrl(input: string): ParsedGitHubShareTarget | null {
  const blob = parseGitHubBlobUrl(input);
  if (blob) return { kind: 'doc', ...blob };

  const tree = parseGitHubTreeUrl(input);
  if (tree) return { kind: 'folder', ...tree };

  return null;
}

/**
 * OK macOS DMG download URL. Re-exported here as the canonical `DOWNLOAD_URL`
 * so splash share-link pages and marketing CTAs stay in sync.
 */
export { DOWNLOAD_URL as SPLASH_DOWNLOAD_URL } from './site';

/**
 * Build the custom-scheme handoff URL the splash's "Open in OpenKnowledge"
 * button fires. V1 keeps its historical direct `url` parameter; v2 carries
 * the canonical token unchanged so content-root depth survives the handoff.
 */
export function buildCustomSchemeUrl(sharedUrl: string, token?: string): string {
  return token === undefined
    ? `openknowledge://share?url=${encodeURIComponent(sharedUrl)}`
    : `openknowledge://share?token=${token}`;
}

/**
 * Install command for the cross-platform CLI receive path. The published
 * package is `@inkeep/open-knowledge`; the two binaries it installs are
 * `open-knowledge` and `ok`.
 */
export const SPLASH_INSTALL_COMMAND = 'npm install -g @inkeep/open-knowledge';

/**
 * POSIX-single-quote a string so it is safe as one shell argument (mirrors
 * `shellSingleQuote` in `@inkeep/open-knowledge-core`; kept copy-local so the
 * static docs build doesn't pull in the workspace dep tree — see file header).
 */
function shellSingleQuoteShareArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Bare tokens that render unquoted in the copyable command. Covers GitHub
// owner/repo names and the common safe ref charset (including `+`, so a ref
// like `release+candidate` renders unquoted); anything outside it is quoted.
const SHARE_SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/@+-]+$/;

function quoteShareArg(s: string): string {
  return SHARE_SHELL_SAFE_TOKEN.test(s) ? s : shellSingleQuoteShareArg(s);
}

/**
 * The CLI silently falls back to the default branch when the ref is missing,
 * so emitting `-b <branch>` unconditionally never clones the wrong ref even on
 * a deleted feature branch — and the splash never has to guess the default
 * branch name. `owner/repo` shorthand is parsed by the CLI's GitHub-URL
 * dispatcher (no need to reconstruct the github.com URL on the splash).
 *
 * Each segment is POSIX-single-quoted when it carries anything outside the bare
 * shell-safe charset, so the rendered command is injection-safe regardless of
 * the ref — `isShareSegmentSafe` validates ref *validity* at the decode
 * boundary; shell *safety* is enforced here, where the command is built. The
 * function does not assume its inputs are pre-sanitized.
 */
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

/**
 * The splash shares the site-wide OS classifier rather than carrying its own —
 * a second copy would let the splash and the rest of the site disagree about
 * what a given browser is.
 */
export type SplashOs = DetectedOs;
export const classifySplashOs = classifyDownloadOs;

/**
 * Query suffix the client appends to the splash Download CTA once it has
 * classified the recipient. Always concrete: an unknown OS falls back to the
 * macOS floor, which is what the route would have served anyway, and naming it
 * explicitly keeps the analytics slice honest instead of recording every
 * undetected visitor as a bare default.
 */
export function splashDownloadQuery(os: SplashOs): string {
  return `?${targetQuery(defaultTargetForOs(os))}`;
}

export type ClipboardCopyOutcome = { kind: 'copied' } | { kind: 'fallback-select' };

/**
 * The 'fallback-select' branch must NEVER be a silent no-op — the caller
 * selects the command text so manual copy is one keystroke and announces the
 * failure to assistive tech. Extracted as a pure function so the success /
 * failure branching is unit-testable without mocking navigator.clipboard.
 */
export function clipboardCopyOutcome(succeeded: boolean): ClipboardCopyOutcome {
  return succeeded ? { kind: 'copied' } : { kind: 'fallback-select' };
}

/**
 * Treat `main` and `master` as the default branches that suppress the
 * branch indicator. Any other branch surfaces a small "on <branch>" hint
 * row beneath the repo path.
 */
function isCommonDefaultBranch(branch: string): boolean {
  return branch === 'main' || branch === 'master';
}

export type SplashView =
  | {
      kind: 'ok';
      /**
       * Whether the share targets a single document (blob URL) or a folder
       * (tree URL). The route uses this to render a file-vs-folder affordance.
       */
      target: 'doc' | 'folder';
      /**
       * The headline label. For a doc this is the path basename
       * (`page.md`). For a folder it's the folder name (last path segment),
       * or the repo name when the folder is the repo/branch root (empty path).
       */
      filename: string;
      /** GitHub host: `github.com` or a GHES hostname. */
      host: string;
      /** True when the share targets a GitHub Enterprise host (not github.com).
       * The splash renders the host prominently in this case so a share can
       * never borrow openknowledge.ai's credibility for an unfamiliar server. */
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

/**
 * The splash route's single decode + parse step. Folds `decodeShareUrl` +
 * `parseGitHubShareUrl` into a discriminated view-model so the route can
 * render the three states (ok / unsupported-version / invalid) without
 * leaking exception flow into JSX. A doc (blob) share and a folder (tree)
 * share both produce an `ok` view, discriminated by `target`.
 *
 * Filename is the URL path basename, decoded verbatim —
 * NO title-case transformation, NO extension stripping. `Q4 OKRs.md`
 * stays `Q4 OKRs.md`; `marketing-playbook.md` stays
 * `marketing-playbook.md`; honesty over polish. A root-folder share
 * (empty tree path) falls back to the repo name as the label.
 */
export function buildSplashViewModel(encoded: string): SplashView {
  let decoded: DecodedShare;
  try {
    decoded = decodeShareUrl(encoded);
  } catch (err) {
    if (err instanceof UnsupportedShareVersionError) {
      return { kind: 'unsupported-version', version: err.version };
    }
    if (!(err instanceof InvalidShareUrlError)) {
      // An unexpected throw (not the expected malformed-token rejection) means
      // this copy-local decoder diverged from the core codec it mirrors, or hit
      // an injected-dep bug. Surface it (server-side → Vercel logs) so a
      // regression is diagnosable instead of collapsing into the generic
      // "invalid link" every recipient sees. Expected InvalidShareUrlError stays
      // quiet so bots hitting /d/<garbage> don't flood the logs.
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
  // Doc shares always have a path basename. Folder shares fall back to the
  // repo name for the repo/branch root (empty path).
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

/**
 * Meta description for a share-link page. Names the shared doc/folder and its
 * repo, and always carries "Open … with <product>" so social/SEO previews state
 * the action. Length lands in the ~50-160 char analyser sweet spot for realistic
 * filenames; callers still pass it through `metaDescription` to clamp pathological
 * lengths.
 */
export function buildShareDescription(view: Extract<SplashView, { kind: 'ok' }>): string {
  const noun = view.target === 'folder' ? 'folder' : 'document';
  const branchSuffix = view.isDefaultBranch ? '' : ` (on ${view.branch})`;
  return `Open ${view.filename} with ${SITE_NAME} — a shared ${noun} from ${view.repoPath}${branchSuffix}.`;
}
