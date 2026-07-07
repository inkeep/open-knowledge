/**
 * Pure helpers for the `POST /api/share/construct-url` handler. The handler
 * itself is inlined into `api-extension.ts` so the route-table meta-test
 * (`packages/app/tests/integration/error-envelope-coverage.test.ts`) — which
 * AST-scans `api-extension.ts` for `const handle... = withValidation(...)`
 * shapes — finds it. The dispatch logic that imports these helpers is the
 * authoritative source; everything in this file is a pure function with
 * focused unit tests in the integration suite at `./construct-url.test.ts`.
 */

import type { ShareConstructUrlErrorCode, ShareFreshness } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';

/**
 * Marketing splash URL base. The `/d/` path prefix is reserved
 * for GitHub-substrate shares; future cloud / project shares (`/s/`, `/p/`)
 * land via separate path prefixes so old clients don't silently mis-decode.
 */
export const SHARE_BASE_URL = 'https://openknowledge.ai/d/';

/** Single source of truth for the handler tag used in logs + telemetry. */
export const SHARE_CONSTRUCT_URL_HANDLER_TAG = 'share-construct-url';

/**
 * Whitelist the path shape we accept from the editor. The path is rendered
 * into a GitHub blob (doc) or tree (folder) URL — segments like `..` would let
 * the URL point at a sibling repo's content, and the `.git` segment would
 * expose git internals. Absolute / consecutive-slash paths fail the same gate
 * so the resulting share URL is never broken-shaped. Among dot-folders, only
 * `.git` is rejected; `.ok`, `.github`, etc. are allowed.
 *
 * The empty path is kind-dependent: a folder share may target the repo/branch
 * root (`path === ''`), but a doc share always names a file, so empty is
 * rejected for `kind === 'doc'`.
 */
export function isValidSharePath(path: string, kind: 'doc' | 'folder'): boolean {
  if (path === '') return kind === 'folder';
  if (path.startsWith('/')) return false;
  // Reject ANY backslash (not just a leading one), matching the sibling
  // `isValidBranchInfoPath` in `git-branch-info.ts`. OK is macOS-only, so `\`
  // is never a path separator here; a backslash in a share path is anomalous
  // and must not reach the GitHub URL builder or `cat-file -e <ref>:<path>`.
  if (path.includes('\\')) return false;
  // Reject control chars (NUL through US, plus DEL) for defense-in-depth +
  // symmetry with `isValidBranchInfoPath`. A control char in the path would
  // survive segment splitting and reach the GitHub blob/tree URL builder (and
  // the receiver's `cat-file -e <ref>:<path>`).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  for (const segment of path.split('/')) {
    if (segment === '..' || segment === '.git') return false;
    if (segment.length === 0) return false;
  }
  return true;
}

/**
 * Build a GitHub blob URL pinned to the given branch + doc path. The branch
 * is percent-encoded as a single URL segment (slashes become `%2F`) because
 * `/blob/feat/foo/file.md` is ambiguous between `branch=feat,path=foo/file.md`
 * and `branch=feat/foo,path=file.md` — the receiver cannot disambiguate
 * without a GitHub API call. The parser (`parseGitHubBlobUrl` in
 * `packages/cli/src/github/url.ts`) decodes the segment back via
 * `decodeURIComponent`. Path segments stay individually encoded so `/`
 * remains a separator there.
 */
export function buildGitHubBlobUrl(
  owner: string,
  repo: string,
  branch: string,
  docPath: string,
): string {
  const encodedBranch = encodeURIComponent(branch);
  const encodedSegments = docPath.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${owner}/${repo}/blob/${encodedBranch}/${encodedSegments}`;
}

/**
 * Build a GitHub tree (folder) URL pinned to the given branch + folder path.
 * Branch + segment encoding mirror `buildGitHubBlobUrl` (the branch is one
 * percent-encoded segment; path segments stay individually encoded so `/`
 * remains a separator). No trailing slash is emitted.
 *
 * When `folderPath === ''` the URL targets the repo/branch root and degenerates
 * to `https://github.com/<owner>/<repo>/tree/<branch>` — no empty trailing
 * segment. The parser (`parseGitHubTreeUrl` in `packages/cli/src/github/url.ts`)
 * accepts that root shape and yields `path: ''`.
 */
export function buildGitHubTreeUrl(
  owner: string,
  repo: string,
  branch: string,
  folderPath: string,
): string {
  const encodedBranch = encodeURIComponent(branch);
  const base = `https://github.com/${owner}/${repo}/tree/${encodedBranch}`;
  if (folderPath === '') return base;
  const encodedSegments = folderPath.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedSegments}`;
}

/**
 * Emit one structured ops log line per request. All fields are non-PII (no
 * project path, no doc filename, no URL bytes). `kind` (`'doc' | 'folder'`)
 * and `freshness` (`'current' | 'stale' | 'absent'`) are bounded enums, so
 * they're safe as span/log attributes per the cardinality STOP rule.
 * `freshness` is omitted when the probe couldn't run (fail-open).
 */
export function emitShareConstructUrlLog(
  result: 'ok' | ShareConstructUrlErrorCode,
  opts?: { branchExists?: boolean; kind?: 'doc' | 'folder'; freshness?: ShareFreshness },
): void {
  const branchExists = opts?.branchExists;
  const kind = opts?.kind;
  const freshness = opts?.freshness;
  getLogger('share').info(
    {
      action: 'construct-url',
      result,
      ...(branchExists === undefined ? {} : { branchExists }),
      ...(kind === undefined ? {} : { kind }),
      ...(freshness === undefined ? {} : { freshness }),
    },
    'share action',
  );
}
