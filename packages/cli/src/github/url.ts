/**
 * Parsed Git URL result.
 */
interface ParsedGitUrl {
  protocol: 'https' | 'ssh' | 'git';
  hostname: string;
  owner: string;
  name: string;
}

/**
 * Parsed GitHub blob URL result.
 */
export interface ParsedGitHubBlobUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

/**
 * Parsed GitHub tree (folder) URL result. `path` is the folder path relative
 * to the repo root and MAY be the empty string for a repo/branch root
 * (`tree/<branch>` or `tree/<branch>/`).
 */
export interface ParsedGitHubTreeUrl {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

/**
 * Unified result of the share-URL dispatcher. A GitHub blob URL is a `doc`
 * target; a GitHub tree URL is a `folder` target (whose `path` may be empty
 * for the repo/branch root).
 */
export type ParsedGitHubShareTarget =
  | { kind: 'doc'; owner: string; repo: string; branch: string; path: string }
  | { kind: 'folder'; owner: string; repo: string; branch: string; path: string };

/**
 * Strip a trailing :port from a hostname string.
 */
function stripPort(hostname: string): string {
  return hostname.replace(/:\d+$/, '');
}

/**
 * Parse a git remote URL or shorthand into its components.
 *
 * Handles:
 *   - https://host[:port]/owner/repo[.git]
 *   - http://host[:port]/owner/repo[.git]
 *   - ssh://[user@]host[:port]/owner/repo[.git]
 *   - git://host[:port]/owner/repo[.git]
 *   - git@host:owner/repo[.git]           (SCP-style SSH)
 *   - [user@]host.ghe.com:owner/repo[.git] (GHES SCP-style)
 *   - git:host/owner/repo[.git]            (bare git protocol)
 *   - owner/repo[.git]                     (shorthand → github.com)
 *
 * Returns null for invalid or unrecognised input.
 */
export function parseGitUrl(input: string): ParsedGitUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  // https:// or http://
  {
    const m = /^https?:\/\/([^/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) return { protocol: 'https', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  // ssh://[user@]host/owner/repo(.git)?
  {
    const m = /^ssh:\/\/(?:[\w.-]+@)?([^/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(
      raw,
    );
    if (m) return { protocol: 'ssh', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  // git://host/owner/repo(.git)?
  {
    const m = /^git:\/\/([^/?#]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) return { protocol: 'git', hostname: stripPort(m[1]), owner: m[2], name: m[3] };
  }

  // SCP-style: [user@]host:owner/repo(.git)?
  // The hostname must contain a dot or be a known hostname pattern (prevents
  // matching Windows-style paths like C:\path or plain "foo:bar/baz").
  {
    const m = /^(?:[\w.-]+@)?([\w.-]+):([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
    if (m?.[1].includes('.')) {
      return { protocol: 'ssh', hostname: m[1], owner: m[2], name: m[3] };
    }
    // Also match well-known SCP host without dot (e.g. git@localhost:owner/repo)
    if (m && raw.startsWith('git@')) {
      return { protocol: 'ssh', hostname: m[1], owner: m[2], name: m[3] };
    }
  }

  // git:host/owner/repo(.git)?  (bare git protocol without //)
  {
    const m = /^git:([\w.-]+)\/([\w.\-~%]+)\/([\w.\-~%]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) return { protocol: 'git', hostname: m[1], owner: m[2], name: m[3] };
  }

  // owner/repo shorthand → github.com
  if (!raw.includes('://') && !raw.includes('@') && !raw.startsWith('/')) {
    const m = /^([\w.-]+)\/([\w.\-~%]+?)(?:\.git)?$/.exec(raw);
    if (m) return { protocol: 'https', hostname: 'github.com', owner: m[1], name: m[2] };
  }

  return null;
}

/**
 * Parse a GitHub blob URL of the form
 *   https://github.com/<owner>/<repo>/blob/<branch>/<path...>
 * into its `{ owner, repo, branch, path }` components.
 *
 * Branch slashes must be percent-encoded (`feat%2Ffoo`) — the URL form
 * `https://github.com/o/r/blob/feat/foo/file.md` is ambiguous between
 * `branch=feat,path=foo/file.md` and `branch=feat/foo,path=file.md`,
 * and we cannot disambiguate without a GitHub API call. The sender
 * encodes; the parser decodes.
 *
 * Returns null for any URL that is not a well-formed GitHub blob URL.
 */
export function parseGitHubBlobUrl(input: string): ParsedGitHubBlobUrl | null {
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

  // Expected shape: [owner, repo, 'blob', branch, ...pathSegments]
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

  return { owner, repo, branch, path: pathParts.join('/') };
}

/**
 * Parse a GitHub tree (folder) URL of the form
 *   https://github.com/<owner>/<repo>/tree/<branch>[/<path...>]
 * into its `{ owner, repo, branch, path }` components.
 *
 * Unlike `parseGitHubBlobUrl`, the folder path MAY be empty — `tree/<branch>`
 * and `tree/<branch>/` both denote the repo/branch root and yield `path: ''`.
 * (The builder emits no trailing slash; the parser tolerates both
 * shapes defensively.)
 *
 * Branch slashes must be percent-encoded (`feat%2Ffoo`) for the same
 * disambiguation reason as the blob parser — the sender encodes, the parser
 * decodes.
 *
 * Returns null for any URL that is not a well-formed GitHub tree URL.
 */
export function parseGitHubTreeUrl(input: string): ParsedGitHubTreeUrl | null {
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
  // empty path segment. The builder emits no trailing slash — this
  // is defensive tolerance only.
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
  // Empty intermediate segments (e.g. `a//b`) are malformed.
  if (pathParts.some((p) => p.length === 0)) return null;

  return { owner, repo, branch, path: pathParts.join('/') };
}

/**
 * Dispatch a share URL to its target kind. A GitHub blob URL resolves to a
 * `doc` target; a GitHub tree URL resolves to a `folder` target. Blob is
 * tried first because the two prefixes (`/blob/` vs `/tree/`) are mutually
 * exclusive — a URL can satisfy at most one.
 *
 * Returns null when the input is neither a well-formed blob nor tree URL.
 */
export function parseGitHubShareUrl(input: string): ParsedGitHubShareTarget | null {
  const blob = parseGitHubBlobUrl(input);
  if (blob) return { kind: 'doc', ...blob };

  const tree = parseGitHubTreeUrl(input);
  if (tree) return { kind: 'folder', ...tree };

  return null;
}
