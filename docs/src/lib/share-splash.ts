/**
 * Splash-local mirrors of the pure functions that live in the OK workspace:
 *
 *   - `decodeShareUrl` mirrors `packages/core/src/sharing/share-url.ts`
 *     (v1 payload = `[0x01] || utf-8(<github-url>)`, base64url-encoded,
 *     with tolerance for trailing `?query` and `#fragment`; decoded field is
 *     `sharedUrl` — a blob URL for a doc share, a tree URL for a folder share)
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
 * mirrored here in lock-step — today that covers the `sharedUrl` field and
 * tree (folder) URL parsing.
 *
 * `buildSplashViewModel(encoded)` is the splash's single entry point — it
 * folds the decoder + dispatcher into a discriminated `SplashView` the route
 * uses to render the three states (ok / unsupported-version / invalid). The
 * `ok` view carries a `target` discriminator so the route can render a
 * file-vs-folder affordance.
 */

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

/**
 * Kind-discriminated share target. A GitHub blob URL is a `doc`; a GitHub tree
 * URL is a `folder` (whose `path` MAY be empty for the repo/branch root).
 */
export type ParsedGitHubShareTarget =
  | { kind: 'doc'; owner: string; repo: string; branch: string; path: string }
  | { kind: 'folder'; owner: string; repo: string; branch: string; path: string };

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

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null;
  }

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

  return { owner, repo, branch, path: pathParts.join('/') };
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
 * button fires. Custom-scheme path carries the shared URL (a blob URL for a
 * doc, a tree URL for a folder) directly without the version byte — that path
 * is the immediate-handoff channel, not the marketing-safe persisted-link
 * channel.
 */
export function buildCustomSchemeUrl(sharedUrl: string): string {
  return `openknowledge://share?url=${encodeURIComponent(sharedUrl)}`;
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

export type SplashOs = 'macos' | 'linux' | 'windows' | 'unknown';

/**
 * Classify the recipient's OS from `navigator.userAgentData.platform`
 * (preferred) OR `navigator.userAgent` (fallback). Returns platform only,
 * NEVER architecture — Apple-Silicon vs Intel is undetectable in-browser:
 * Apple freezes the macOS UA to "Intel Mac OS X" on both, and UA Client
 * Hints are Chromium-only and misreport under Rosetta. Mobile (iOS/Android)
 * falls through to 'unknown' so the server-rendered macOS floor is the safe
 * rendering — they can't run the desktop app or the CLI.
 */
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

/**
 * Per-OS CTA layout decision for the splash, extracted as a pure function so the
 * branch logic is unit-testable: a Linux-branch regression (dropping the GitHub
 * fallback) previously reached QA because this rendering decision had no test.
 * Invariant: GitHub stays reachable on every OS — the cluster carries it on
 * macOS/unknown, a standalone link on Linux, the not-supported notice on Windows.
 */
export interface SplashCtaLayout {
  /** Windows: replace the CTAs with the not-supported notice (which keeps GitHub). */
  showWindowsNotice: boolean;
  /** Render the DMG + deep-link + GitHub cluster (the macOS/unknown floor). */
  showCluster: boolean;
  /** Render the CLI inline (Linux) vs. inside the Download dropdown popover (macOS/unknown). */
  cliInline: boolean;
  /** Render a standalone GitHub fallback link (Linux, where the cluster is dropped). */
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
  // macOS / unknown: the server-rendered floor — cluster (with GitHub); the CLI lives in the Download popover.
  return {
    showWindowsNotice: false,
    showCluster: true,
    cliInline: false,
    showStandaloneGithub: false,
  };
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
    return { kind: 'invalid' };
  }

  const parsed = parseGitHubShareUrl(decoded.sharedUrl);
  if (!parsed) {
    return { kind: 'invalid' };
  }

  const { kind, owner, repo, branch, path } = parsed;
  const segments = path.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  // Doc shares always have a path basename. Folder shares fall back to the
  // repo name for the repo/branch root (empty path).
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
