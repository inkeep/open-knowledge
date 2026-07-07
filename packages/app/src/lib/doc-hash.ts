import { MANAGED_ARTIFACT_SCOPES, type SkillScope } from '@inkeep/open-knowledge-core';

/** Narrow a free string to a known skill scope (`project` | `global`). */
function isSkillScope(value: string): value is SkillScope {
  return (MANAGED_ARTIFACT_SCOPES as readonly string[]).includes(value);
}

/** Parse a docName from a `#/<path>?<query>` hash. Returns null if the hash
 * is empty, malformed, or not in the `#/` namespace.
 *
 * Browsers percent-encode spaces and non-ASCII characters in
 * `window.location.hash`. This helper decodes per-segment so the returned
 * docName matches the server's on-disk name (e.g. `My Notes/Ideas — 2026`). */
export function docNameFromHash(hash: string): string | null {
  if (hash.startsWith(ASSET_HASH_PREFIX)) return null;
  // Skill bundle files (`#/__skill-file__/…`) are a viewer route, not a doc —
  // they resolve via `skillFileFromHash`, so don't mis-read them as a docName.
  if (hash.startsWith(SKILL_FILE_HASH_PREFIX)) return null;
  // Skill (`#/__skill__/…`) and template (`#/__template__/…`) hashes ARE
  // documents — they open as ordinary editor tabs, so they resolve to their
  // synthetic doc name here like any other `#/<docName>` hash (per-segment
  // decode below yields the raw `__skill__/<scope>/<name>` key the tab uses).
  if (!hash.startsWith('#/')) return null;
  const rest = hash.slice(2);
  const delimiter = firstRouteDelimiterIndex(rest);
  const encoded = delimiter >= 0 ? rest.slice(0, delimiter) : rest;
  if (!encoded) return null;
  try {
    return encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    // Malformed percent-encoding — fall back to raw string so the caller can
    // at least attempt a lookup rather than silently dropping the navigation.
    return encoded;
  }
}

/** Parse the optional section anchor from a document hash. */
export function anchorFromHash(hash: string): string | null {
  if (hash.startsWith(ASSET_HASH_PREFIX)) return null;
  if (!hash.startsWith('#/')) return null;

  const rest = hash.slice(2);
  const fragment = rest.indexOf('#');
  if (fragment < 0) return null;
  const encoded = rest.slice(fragment + 1);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** Build a `#/<docName>#<anchor>` hash for the given docName. */
export function hashFromDocName(docName: string, anchor?: string | null): string {
  const base = `#/${docName}`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}

export function replaceHashWithoutNavigation(hash: string): void {
  if (window.location.hash === hash) return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}${hash}`);
}

/**
 * Strip the `.md` / `.mdx` extension from an on-disk file path to produce
 * the editor's extension-less docName key. `/api/sync/conflicts` reports
 * paths with the extension; the URL hash + DocumentContext key off the
 * extension-less form.
 */
export function filePathToDocName(filePath: string): string {
  if (filePath.endsWith('.mdx')) return filePath.slice(0, -4);
  if (filePath.endsWith('.md')) return filePath.slice(0, -3);
  return filePath;
}

/** Build a `#/<folderPath>/#<anchor>` hash for a folder target. */
export function hashFromFolderPath(folderPath: string, anchor?: string | null): string {
  const normalized = folderPath.replace(/^\/+|\/+$/g, '');
  const base = normalized ? `#/${normalized}/` : '#/';
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}

/**
 * Build the hash for a share-receive deep link, dispatching on the share's
 * target kind. Kept beside the two sibling builders so the receive-flow's
 * deep-link listener has a single kind-aware entry point.
 *
 * - `kind: 'doc'` → `#/<doc>?branch=<branch>` (the existing doc form;
 *   `branch` rides as a query param so the in-app branch-switch flow can
 *   pick it up). Empty/null branch omits the query.
 * - `kind: 'folder'` → `#/<folderPath>/` (trailing-slash folder form). An
 *   empty `path` is the content-root sentinel and yields the root hash `#/`
 *   (= contentDir root in OK's hash semantics). No `?branch=` is appended:
 *   the branch-switch decision is resolved upstream (via the await-CC1
 *   flow) BEFORE navigation, so folder navigation matches how in-app
 *   folder navigation builds its hash (`hashFromFolderPath`, no branch
 *   query).
 */
export function encodeShareTargetForHash(
  kind: 'doc' | 'folder',
  path: string,
  branch?: string | null,
): string {
  if (kind === 'folder') return hashFromFolderPath(path);
  const base = `#/${encodeURIComponent(path)}`;
  if (branch === undefined || branch === null || branch === '') return base;
  return `${base}?branch=${encodeURIComponent(branch)}`;
}

/**
 * `true` iff the hash is the content-root sentinel `#/` (the form
 * `hashFromFolderPath('')` emits and a root-folder share deep link
 * navigates to). Distinct from an EMPTY hash (`''`), which means "no
 * selection" and clears the active target. NavigationHandler routes `#/`
 * to the content-root `<FolderOverview folderPath="">` instead of the
 * empty-editor state.
 *
 * Trailing-query tolerant (`#/?anchor=...`) for symmetry with the other
 * parsers, though the root form carries no anchor today.
 */
export function isContentRootHash(hash: string): boolean {
  if (hash === '#/') return true;
  if (!hash.startsWith('#/')) return false;
  const rest = hash.slice(2);
  // `#/` followed only by a query (`?...`) is still the root — there is no
  // path segment before the delimiter.
  return rest.length > 0 && rest[0] === '?';
}

const ASSET_HASH_PREFIX = '#/__asset__/';

function firstRouteDelimiterIndex(rest: string): number {
  const qmark = rest.indexOf('?');
  const fragment = rest.indexOf('#');
  if (qmark < 0) return fragment;
  if (fragment < 0) return qmark;
  return Math.min(qmark, fragment);
}

export function assetPathFromHash(hash: string): string | null {
  if (!hash.startsWith(ASSET_HASH_PREFIX)) return null;
  const encoded = hash.slice(ASSET_HASH_PREFIX.length);
  if (!encoded) return null;
  try {
    return encoded.split('/').map(decodeURIComponent).join('/');
  } catch {
    return encoded;
  }
}

export function hashFromAssetPath(assetPath: string): string {
  return `${ASSET_HASH_PREFIX}${assetPath.split('/').map(encodeURIComponent).join('/')}`;
}

const SKILL_FILE_HASH_PREFIX = '#/__skill-file__/';

/**
 * A skill bundle file (`references/**` / `scripts/**`) is neither a content doc
 * nor a content-dir asset — for a GLOBAL skill it lives under `~/.ok/skills/`,
 * outside the project. It opens in a read-only viewer that reads the
 * scope-aware `/api/skill-file` endpoint, so its hash round-trips the three
 * coordinates (scope / name / path) that endpoint needs, rather than a single
 * file path. Each coordinate is percent-encoded as one segment; `path` may
 * itself contain `/`, so it is the tail and joins its own segments.
 */
export interface SkillFileHashTarget {
  scope: SkillScope;
  name: string;
  path: string;
}

export function hashFromSkillFile(target: SkillFileHashTarget): string {
  const head = [target.scope, target.name].map(encodeURIComponent).join('/');
  const tail = target.path.split('/').map(encodeURIComponent).join('/');
  return `${SKILL_FILE_HASH_PREFIX}${head}/${tail}`;
}

export function skillFileFromHash(hash: string): SkillFileHashTarget | null {
  if (!hash.startsWith(SKILL_FILE_HASH_PREFIX)) return null;
  const encoded = hash.slice(SKILL_FILE_HASH_PREFIX.length);
  if (!encoded) return null;
  let segments: string[];
  try {
    segments = encoded.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  // scope + name + at least one path segment.
  if (segments.length < 3) return null;
  const [scope, name, ...rest] = segments;
  const path = rest.join('/');
  // The hash is from `window.location` — untrusted/editable — so validate the
  // scope against the known set rather than letting any string through.
  if (!scope || !name || !path || !isSkillScope(scope)) return null;
  return { scope, name, path };
}
