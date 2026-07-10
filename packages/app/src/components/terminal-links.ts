/**
 * Pure detection + resolution for clickable file-path links in the terminal.
 *
 * The xterm wiring (registerLinkProvider, bridge calls, React lifecycle) lives
 * in `terminal-link-provider.ts` + `TerminalPanel.tsx`; everything here is
 * side-effect-free so the heuristics can be unit-tested against a corpus.
 *
 * URLs are NOT handled here — `WebLinksAddon` owns implicit `http(s)` detection
 * (its `strictUrlRegex` + `new URL()` round-trip gate are battle-tested). This
 * module only finds POSIX file paths (desktop is macOS-only, so no Windows
 * drive/UNC clauses) and turns them into project-relative targets.
 *
 * Philosophy (matching VSCode / iTerm2): parse generously, then gate on
 * existence at the call site. A generous regex plus a `checkTargetExists` probe
 * beats a clever regex with no validation — false positives never underline.
 */

import type { PageListCacheSnapshot } from '../editor/page-list-cache';
import { filePathToDocName } from '../lib/doc-hash';

/** A path token found in a line of terminal output. */
export interface PathCandidate {
  /**
   * The path portion with any trailing `:line[:col]` suffix and trailing
   * sentence punctuation removed. This is what gets resolved.
   */
  readonly path: string;
  /** 0-based index of `path`'s first char in the source line. */
  readonly startIndex: number;
  /** 0-based index one past `path`'s last char (exclusive). */
  readonly endIndex: number;
  /** True when the raw token ended in `/` — a folder reference. */
  readonly trailingSlash: boolean;
}

/** How an in-project target opens. */
export type TerminalLinkKind = 'doc' | 'folder' | 'asset';

/**
 * A validated, routable terminal link target. In-project targets open in the
 * editor / OS default app; an `external` target (an existing path outside the
 * current project) instead offers a reveal-in-Finder dialog on click.
 */
export type TerminalLinkTarget =
  | {
      readonly kind: TerminalLinkKind;
      /** contentDir-relative, POSIX-separated, no leading `/`, no trailing `/`. */
      readonly relPath: string;
    }
  | {
      readonly kind: 'external';
      /** Absolute on-disk path outside `projectPath`. */
      readonly absPath: string;
    };

/** Outcome of resolving a detected path token against the project root. */
export type ResolvedTerminalPath =
  | { readonly kind: 'in-project'; readonly relPath: string }
  | { readonly kind: 'external'; readonly absPath: string };

/**
 * Resolve a detected path token to either an in-project relative path or an
 * out-of-project absolute path — or `null` when it isn't routable.
 *
 * - In-project (absolute-inside or clean relative) → `{ kind: 'in-project' }`.
 * - Absolute path outside the project (and not the root itself) →
 *   `{ kind: 'external' }` — clicking offers a reveal-in-Finder dialog.
 * - A relative `..`-escape stays `null`: once the shell `cd`s the true cwd
 *   diverges from the spawn cwd, so a relative token that escapes the project
 *   is ambiguous and not made clickable. Only absolute paths route external.
 */
export function resolveTerminalPath(
  rawPath: string,
  projectPath: string,
): ResolvedTerminalPath | null {
  const rel = toProjectRelative(rawPath, projectPath);
  if (rel !== null) return { kind: 'in-project', relPath: rel };
  // `toProjectRelative` collapses "outside the project" AND "is the root" both to
  // `null`, so re-distinguish them here: an in-tree absolute would have returned
  // a relPath above, so a still-absolute path is genuinely external.
  if (rawPath.startsWith('/')) {
    if (rawPath === normalizeRoot(projectPath)) return null; // the root isn't a file.
    return { kind: 'external', absPath: rawPath };
  }
  return null;
}

/** Normalize the project root (drop trailing slashes) for prefix comparison. */
function normalizeRoot(projectPath: string): string {
  return projectPath.replace(/\/+$/, '');
}

const MAX_LINE_LENGTH = 2000;

/**
 * Runs of non-whitespace, non-delimiter characters. `:` and `.` stay INSIDE a
 * run so `foo.ts:12` is one token (the suffix is split off afterwards);
 * brackets, quotes, pipes, angle brackets, and NUL are excluded so they act as
 * boundaries (they can't appear in a path we would open, and they bound
 * `(url)` / `[path]` enclosures).
 */
const RUN_RE = /[^\s<>"'`|(){}[\]\0]+/g;

/**
 * Trailing `:line[:col]` suffix (the dominant unix / compiler / ripgrep form),
 * stripped from the token so it stays out of the underlined range. `(line,col)`
 * isn't matched: `(` is a run boundary (below), so an enclosing paren already
 * strips to the bare path.
 */
const SUFFIX_RE = /:\d+(?::\d+)?$/;

/** Scheme-prefixed tokens (`https://`, `file://`, …) belong to WebLinksAddon. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A bare leaf (no `/`) is only a candidate when it carries an extension. */
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/**
 * True when the token ends in a file extension (`.md`, `.ts`, `.tar.gz` → yes).
 * Used to decide whether a slash-less token that missed the file probe is worth
 * retrying as a directory — extension-less tokens (`src`, `node_modules`) are
 * the plausible bare-directory case; `report.md` is not.
 */
export function hasPathExtension(token: string): boolean {
  return HAS_EXTENSION_RE.test(token);
}

/**
 * Extract path candidates from one line of terminal text. Generous by design —
 * callers validate existence before decorating. Returns at most `maxCandidates`
 * results (bounds downstream `stat` work per line).
 */
export function detectPathCandidates(line: string, maxCandidates = 10): PathCandidate[] {
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return [];
  const out: PathCandidate[] = [];

  for (const match of line.matchAll(RUN_RE)) {
    if (out.length >= maxCandidates) break;
    const run = match[0];
    const runStart = match.index;

    // URLs are WebLinksAddon's job.
    if (SCHEME_RE.test(run)) continue;

    // Trim trailing sentence punctuation FIRST (`foo.md.` / `bar,` / `baz:`), so
    // a `:line[:col]` suffix followed by punctuation (`error at src/a.ts:12,` — a
    // common compiler / ripgrep shape) still strips to the bare path below.
    let path = run.replace(/[.,;:!?]+$/, '');

    // Strip a trailing `:line[:col]` suffix so it stays out of the underlined
    // range — the link resolves to the path, not `path:12`. (Line info isn't
    // consumed yet; the editor has no line-scroll target.)
    const suffix = path.match(SUFFIX_RE);
    if (suffix) path = path.slice(0, suffix.index);

    const trailingSlash = path.endsWith('/');
    const core = trailingSlash ? path.slice(0, -1) : path;
    if (!isPathShaped(core)) continue;

    // `endIndex` is one past `core`'s last char — the underlined range is exactly
    // the emitted path, excluding any stripped suffix / trailing slash.
    const endIndex = runStart + core.length;
    out.push({ path: core, startIndex: runStart, endIndex, trailingSlash });
  }

  return out;
}

/** An xterm buffer range: 1-based columns, 1-based buffer rows, `end` inclusive. */
export interface TerminalBufferRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/**
 * Map a `[startIndex, endIndex)` span of a RECONSTRUCTED logical line back to an
 * xterm buffer range. A logical line wider than the terminal is stored across
 * several rows (`cols` chars each); `startLine` is the 1-based buffer row where
 * it begins. A span that crosses a wrap boundary produces a range whose
 * `start.y` and `end.y` differ — xterm supports multi-row link ranges, so a
 * wrapped path underlines and hit-tests correctly across rows. `end` is the
 * INCLUSIVE cell of the last char (xterm's convention), derived from
 * `endIndex - 1`.
 */
export function terminalBufferRange(
  startIndex: number,
  endIndex: number,
  startLine: number,
  cols: number,
): TerminalBufferRange {
  // A non-positive width can't wrap; keep the whole span on `startLine`.
  const width = cols > 0 ? cols : Number.MAX_SAFE_INTEGER;
  const lastIndex = Math.max(startIndex, endIndex - 1);
  const cell = (i: number) => ({ x: (i % width) + 1, y: startLine + Math.floor(i / width) });
  return { start: cell(startIndex), end: cell(lastIndex) };
}

/**
 * True when `token` looks like a file/folder path worth validating: it either
 * contains a separator (`src/foo`, `./a`, `/abs`) or is a bare leaf with an
 * extension (`report.md`). Pure-word and pure-numeric tokens are rejected so we
 * don't probe every word on the line.
 */
function isPathShaped(token: string): boolean {
  if (token.length < 2) return false;
  if (token.startsWith('~')) return false; // home paths need a homedir we don't have.
  if (token.includes('/')) return true;
  return HAS_EXTENSION_RE.test(token);
}

/**
 * Resolve a detected path to a clean, contentDir-relative path — or `null` when
 * it escapes the project. `projectPath` is the PTY cwd (`bridge.config.projectPath`).
 *
 * Rejections (all mean "not a clickable in-project target"):
 *  - absolute paths outside `projectPath`
 *  - any `..` segment (would escape; the PTY cwd is the project root)
 *  - empty / current-dir-only results
 *
 * The returned form is what `checkTargetExists` + `openAsset` expect: no leading
 * `/`, no trailing `/`, no `./` prefix, POSIX separators.
 */
export function toProjectRelative(rawPath: string, projectPath: string): string | null {
  if (!rawPath || !projectPath) return null;
  const root = normalizeRoot(projectPath);

  let rel: string;
  if (rawPath.startsWith('/')) {
    // Absolute — only clickable if it lives inside the project tree.
    if (rawPath === root) return null; // the root itself is not a doc/asset.
    const prefix = `${root}/`;
    if (!rawPath.startsWith(prefix)) return null;
    rel = rawPath.slice(prefix.length);
  } else {
    rel = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
  }

  // Normalize separators; drop empty + current-dir segments; reject escapes.
  const segments: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * Decide how an existing target opens: docs open in the editor, folders navigate
 * to their overview, everything else OS-delegates via `openAsset`.
 *
 * `snapshot` (the page-list cache) lets tracked content route without any probe;
 * `trailingSlash` disambiguates a folder reference that isn't yet in the cache.
 */
export function classifyTarget(
  relPath: string,
  trailingSlash: boolean,
  snapshot: PageListCacheSnapshot | null,
): TerminalLinkKind {
  if (trailingSlash) return 'folder';
  if (snapshot?.folderPaths.has(relPath)) return 'folder';
  if (relPath.endsWith('.md') || relPath.endsWith('.mdx')) return 'doc';
  if (snapshot?.pages.has(filePathToDocName(relPath))) return 'doc';
  return 'asset';
}

/**
 * Guard against opening the same URL twice from a single click. xterm runs two
 * link layers over the same cells — the core OSC 8 handler (`Terminal.linkHandler`)
 * and `WebLinksAddon` — and when a URL is emitted as an OSC 8 hyperlink whose
 * visible text is itself the URL (what the `claude` TUI and many CLIs do), BOTH
 * match and both fire `activate`, opening the browser twice. Routing both handlers
 * through this guard collapses the same-URL, same-gesture pair into one open while
 * leaving OSC 8 links with custom display text (text ≠ target) fully functional.
 *
 * `now` is injected so the guard is deterministically testable. Returns `true`
 * when the caller should SUPPRESS this open (a duplicate within `windowMs`).
 */
export function createRecentOpenGuard(windowMs = 300): (uri: string, now: number) => boolean {
  let last: { uri: string; at: number } | null = null;
  return (uri, now) => {
    if (last !== null && last.uri === uri && now - last.at < windowMs) return true;
    last = { uri, at: now };
    return false;
  };
}

/**
 * Synchronous existence check against the page-list cache — a fast path that
 * avoids an IPC round-trip for content the app already tracks. Returns `true`
 * (known to exist), `false` (unknown — caller must probe), never a false
 * negative for tracked content.
 */
export function isKnownInSnapshot(
  relPath: string,
  trailingSlash: boolean,
  snapshot: PageListCacheSnapshot | null,
): boolean {
  if (!snapshot) return false;
  if (trailingSlash) return snapshot.folderPaths.has(relPath);
  if (snapshot.pages.has(filePathToDocName(relPath))) return true;
  if (snapshot.assetPaths?.has(relPath)) return true;
  if (snapshot.filePaths?.has(relPath)) return true;
  return snapshot.folderPaths.has(relPath);
}
