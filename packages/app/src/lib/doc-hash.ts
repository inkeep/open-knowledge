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
  // The Skills hub (`#/__skills__`) is a full-pane destination, not a doc.
  if (hash.startsWith(SKILLS_HASH_PREFIX)) return null;
  // A pre-install skill preview (`#/__skill-preview__/…`) is a full-pane viewer
  // keyed by import coordinates, not a doc — it resolves via `skillPreviewFromHash`.
  if (hash.startsWith(SKILL_PREVIEW_HASH_PREFIX)) return null;
  // A global-skill hash (`#/__skill__/…`) and a LEGACY template hash
  // (`#/__template__/…`) decode to their raw name here like any other
  // `#/<docName>` hash; a legacy template name is then redirected to its content
  // doc at navigation resolution. New templates use their content-path hash
  // (`#/<folder>/.ok/templates/<name>`), decoded per-segment like any doc.
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

/**
 * A surrogate with no partner. `encodeURIComponent` throws `URIError` on one,
 * and it has no partial result, so one bad code unit would otherwise cost the
 * whole value its escaping.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Percent-encode one hash component: a path segment, an anchor, a branch name.
 *
 * Every value these builders escape ultimately comes from a filename, and a
 * filename can carry an unpaired surrogate. Substituting U+FFFD first keeps
 * the call total, so the rest of the value is still escaped and the builders
 * cannot throw — they run inside render paths, where a `URIError` takes out
 * the surrounding tree rather than breaking one link. The substitution is
 * visible in the URL as `%EF%BF%BD` rather than silently corrupting the route.
 *
 * Mirrors the sanitizer in `packages/server/src/services/search.ts`, including
 * why `String.prototype.toWellFormed` is not used: this subtree targets ES2022.
 */
function encodeSegment(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\uFFFD'));
}

/**
 * Percent-encode a route path one `/`-separated segment at a time, so the
 * separators survive while everything else is escaped.
 *
 * Encoding matters most for `#`: the browser does not escape it when the hash
 * is assigned, so an unescaped one in a name comes back looking like the start
 * of an anchor.
 */
function encodeRoutePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

/**
 * Build a `#/<docName>#<anchor>` hash for the given docName.
 *
 * The path is encoded per segment so that `/` stays a real route separator
 * while every other character is escaped, mirroring the per-segment decode in
 * `docNameFromHash`. Encoding matters most for `#`: the browser does not
 * escape it when the hash is assigned, so an unescaped one in a docName would
 * come back looking like the start of the anchor. The parser then reads only
 * the text before it, which is the empty string for a leading `#` and a
 * truncated name for one in the middle.
 */
export function hashFromDocName(docName: string, anchor?: string | null): string {
  const base = `#/${encodeRoutePath(docName)}`;
  return anchor ? `${base}#${encodeSegment(anchor)}` : base;
}

/**
 * `true` when two hashes address the same target, tolerating the
 * percent-encoding difference between the two ways a hash reaches us.
 *
 * The `hashFrom*` builders encode the path, so a freshly built hash and the
 * `window.location.hash` the browser hands back are normally identical and
 * settle on the `===` fast path. The decode earns its place for hashes this
 * app did not build: entries persisted in history or a bookmark by an older
 * build, whose builders emitted the path raw (`#/My Notes/`), and hashes typed
 * or edited by hand in the address bar. Without the tolerance a `===` against
 * those is false for every name carrying a space or non-ASCII character, which
 * silently inverts any "are we already here?" guard for exactly those
 * documents and folders.
 *
 * Both sides are decoded rather than just the location side, so the arguments
 * commute — callers pass location first or second depending on the call site.
 *
 * Two residual ambiguities survive the encoding:
 *
 * A raw name that itself contains a percent escape (`100%20`) shares a hash
 * with its decoded form (`100 `), and the two cannot be told apart after the
 * fact. A hash built here cannot collide that way, because the escape's `%` is
 * itself encoded, so the ambiguity is confined to legacy and hand-written
 * input.
 *
 * The decode is whole-string, so it also collapses an encoded `%23` back to a
 * structural `#`: a document named `a#b` and the anchor `b` on document `a`
 * compare equal, even though their built hashes are distinguishable
 * (`#/a%23b` versus `#/a#b`). Telling those apart means decoding the path and
 * anchor separately rather than the whole string, which changes this guard for
 * every caller and is deliberately not attempted here.
 */
export function isSameHash(a: string, b: string): boolean {
  return a === b || decodeHashForComparison(a) === decodeHashForComparison(b);
}

function decodeHashForComparison(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    // Malformed escape — the raw string is still a usable comparison key.
    return hash;
  }
}

const MANAGED_HASH_HISTORY_STATE_KEY = '__okHashHistoryEntry';

function managedHashHistoryState(state: unknown): Record<string, unknown> {
  const preservedState = typeof state === 'object' && state !== null ? state : {};
  return { ...preservedState, [MANAGED_HASH_HISTORY_STATE_KEY]: true };
}

export function isManagedHashHistoryState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[MANAGED_HASH_HISTORY_STATE_KEY] === true
  );
}

export function markCurrentHashHistoryEntry(): void {
  if (isManagedHashHistoryState(window.history.state)) return;
  window.history.replaceState(managedHashHistoryState(window.history.state), '');
}

export function replaceHashWithoutNavigation(hash: string): void {
  const { pathname, search } = window.location;
  window.history.replaceState(
    managedHashHistoryState(window.history.state),
    '',
    `${pathname}${search}${hash}`,
  );
}

export function pushHashWithoutNavigation(hash: string): void {
  if (isSameHash(window.location.hash, hash)) return;
  const { pathname, search } = window.location;
  window.history.pushState(
    managedHashHistoryState(window.history.state),
    '',
    `${pathname}${search}${hash}`,
  );
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

/**
 * Build a `#/<folderPath>/#<anchor>` hash for a folder target.
 *
 * Encoded per segment for the same reason as `hashFromDocName`. The trailing
 * slash stays outside the encoding so it remains the folder marker the parser
 * looks for, and an empty path still yields the `#/` content-root sentinel.
 */
export function hashFromFolderPath(folderPath: string, anchor?: string | null): string {
  const normalized = folderPath.replace(/^\/+|\/+$/g, '');
  const base = normalized ? `#/${encodeRoutePath(normalized)}/` : '#/';
  return anchor ? `${base}#${encodeSegment(anchor)}` : base;
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
  const base = `#/${encodeSegment(path)}`;
  if (branch === undefined || branch === null || branch === '') return base;
  return `${base}?branch=${encodeSegment(branch)}`;
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
  return `${ASSET_HASH_PREFIX}${encodeRoutePath(assetPath)}`;
}

const SKILL_FILE_HASH_PREFIX = '#/__skill-file__/';

// Retired route. Nothing MINTS this hash any more — Skills live in the sidebar
// dock, not behind a full-pane route — but it is still parsed so an old bookmark
// or a restored history entry resolves and redirects instead of dead-ending.
const SKILLS_HASH_PREFIX = '#/__skills__';
export function skillsFromHash(hash: string): boolean {
  return hash === SKILLS_HASH_PREFIX || hash.startsWith(`${SKILLS_HASH_PREFIX}/`);
}

/**
 * A pre-install skill preview is a full-pane read-only view of an un-imported
 * skill, opened before it exists as a project doc — so its hash carries the
 * import coordinates the preview + Manage need rather than a doc name. `flavor`
 * selects the acquire path (`explore` = skills.sh `owner/repo`; `detected` = a
 * skill found in another tool, managed by name + harness; `foreign` = the same
 * but living outside the open project, where the one action is a copy IN). Each coordinate is
 * one percent-encoded segment (source/subtitle may themselves contain `/`).
 */
const SKILL_PREVIEW_HASH_PREFIX = '#/__skill-preview__/';
/** The skill-preview surfaces, single-sourced. Add a flavor here and every
 *  hash/tab-id validator + target type picks it up. */
const SKILL_PREVIEW_FLAVORS = ['explore', 'detected', 'builtin', 'foreign', 'linked'] as const;
export type SkillPreviewFlavor = (typeof SKILL_PREVIEW_FLAVORS)[number];
/** Type-guard for an untrusted flavor (from a `window.location` hash or a
 *  persisted, hand-editable tab id). */
function isSkillPreviewFlavor(v: string | undefined): v is SkillPreviewFlavor {
  return v !== undefined && (SKILL_PREVIEW_FLAVORS as readonly string[]).includes(v);
}
export interface SkillPreviewHashTarget {
  flavor: SkillPreviewFlavor;
  source: string;
  name: string;
  /** Repo (explore) or harness home (detected); doubles as the detected skill's source harness. */
  subtitle: string;
  /** The scope the skill sits at (detected: its provenance level). Read-only display. */
  level?: SkillScope;
  /** The selected bundle file within the preview (`SKILL.md` / `references/x.md`);
   *  absent = SKILL.md. Drives the FILES-list selection + deep-link, so a sidebar
   *  click and the preview's own FILES list share one selection. NOT part of the
   *  tab IDENTITY ({@link encodeSkillPreviewSegments} omits it) — one preview tab
   *  switches its body across files instead of spawning a tab per file. */
  path?: string;
}

/**
 * The level a preview sits at when a caller names none. Matches what
 * `SkillPreviewTab` itself falls back to, so normalizing an absent level here
 * changes no behavior — it only removes the second spelling of one identity.
 */
const DEFAULT_PREVIEW_LEVEL: SkillScope = 'project';

/** Encode a skill-preview target's IDENTITY segments — shared by the location
 *  hash ({@link hashFromSkillPreview}) and the persisted tab id
 *  (`skillPreviewTabId`), which differ only in their prefix. Deliberately omits
 *  `path`: the tab identity is path-independent so one preview tab is reused as
 *  the selection changes. The hash appends `path` separately (see
 *  {@link hashFromSkillPreview}).
 *
 *  `level` is ALWAYS encoded, defaulted rather than dropped. It is optional on
 *  the target, and while it was optional here too the same preview had two
 *  spellings — a caller that passed the level and one that did not produced
 *  different tab ids for the same skill, so the same source+name opened a
 *  SECOND tab with an identical label, and closing one left its twin behind. */
export function encodeSkillPreviewSegments(target: SkillPreviewHashTarget): string {
  return [
    target.flavor,
    target.source,
    target.name,
    target.subtitle,
    target.level ?? DEFAULT_PREVIEW_LEVEL,
  ]
    .map(encodeSegment)
    .join('/');
}

/** Decode skill-preview coordinate segments from an untrusted, hand-editable
 *  string (a `window.location` hash or a persisted tab id); null when malformed
 *  or the flavor / required coordinates don't validate. A 6th segment is the
 *  selected-file `path` (hash only; tab ids never carry it). */
export function decodeSkillPreviewSegments(body: string): SkillPreviewHashTarget | null {
  if (!body) return null;
  let segments: string[];
  try {
    segments = body.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length < 4 || segments.length > 6) return null;
  const [flavor, source, name, subtitle, level, path] = segments;
  if (!isSkillPreviewFlavor(flavor)) return null;
  if (!source || !name) return null;
  return {
    flavor,
    source,
    name,
    subtitle: subtitle ?? '',
    ...(level && isSkillScope(level) ? { level } : {}),
    ...(path ? { path } : {}),
  };
}

export function hashFromSkillPreview(target: SkillPreviewHashTarget): string {
  let body = encodeSkillPreviewSegments(target);
  // The identity is always 5 segments now (level defaulted, never dropped), so
  // `path` is unambiguously the 6th with no padding.
  if (target.path) body += `/${encodeSegment(target.path)}`;
  return `${SKILL_PREVIEW_HASH_PREFIX}${body}`;
}

export function skillPreviewFromHash(hash: string): SkillPreviewHashTarget | null {
  if (!hash.startsWith(SKILL_PREVIEW_HASH_PREFIX)) return null;
  return decodeSkillPreviewSegments(hash.slice(SKILL_PREVIEW_HASH_PREFIX.length));
}

/** Preserve a preview's hash-only file selection only for that same tab identity. */
export function selectedPathForSkillPreview(
  hash: string,
  target: SkillPreviewHashTarget,
): string | undefined {
  const hashTarget = skillPreviewFromHash(hash);
  if (!hashTarget) return undefined;
  return encodeSkillPreviewSegments(hashTarget) === encodeSkillPreviewSegments(target)
    ? hashTarget.path
    : undefined;
}

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
  /**
   * Which same-named bundle this file belongs to. Several distinct-content
   * skills can share a name across host dirs, so without it a reopened tab
   * refetches whichever bundle a bare name lookup lands on — the wrong bytes.
   * Omitted (and on any hash written before this existed) = the by-name default.
   */
  host?: string;
}

/** `:` can't appear in a skill name (`^[a-z0-9-]+$`), so it can't be mistaken
 *  for one — which is what makes host-less legacy hashes still parse. */
const SKILL_FILE_HOST_SEP = ':';

export function hashFromSkillFile(target: SkillFileHashTarget): string {
  const named =
    target.host === undefined ? target.name : `${target.name}${SKILL_FILE_HOST_SEP}${target.host}`;
  const head = [target.scope, named].map(encodeSegment).join('/');
  const tail = encodeRoutePath(target.path);
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
  const [scope, named, ...rest] = segments;
  const path = rest.join('/');
  // The hash is from `window.location` — untrusted/editable — so validate the
  // scope against the known set rather than letting any string through.
  if (!scope || !named || !path || !isSkillScope(scope)) return null;
  const sep = named.indexOf(SKILL_FILE_HOST_SEP);
  const name = sep === -1 ? named : named.slice(0, sep);
  const host = sep === -1 ? undefined : named.slice(sep + 1);
  if (!name) return null;
  return { scope, name, path, ...(host ? { host } : {}) };
}
