import { resolveSkillBundleWikiTarget, resolveSkillSlashTarget } from '../constants/cc1.ts';
import { DEFAULT_DOC_EXTENSION } from '../constants/doc-extensions.ts';
import {
  decodeHrefPath,
  decodeHrefPathSegment,
  encodeHrefPath,
  type ResolvedInternalHref,
  resolveInternalHref,
} from './resolve-internal-href.ts';

export interface DocLinkTarget extends ResolvedInternalHref {
  kind: 'doc';
}

export interface ExternalLinkTarget {
  kind: 'external';
  url: string;
}

export interface AnchorLinkTarget {
  kind: 'anchor';
  anchor: string;
}

/**
 * Asset link — reference to a non-markdown file on disk (PDF, video, audio,
 * archive, etc.) OR an external URL pointing at an asset extension. The
 * renderer routes `asset` clicks through the asset-click dispatcher + registry
 * rather than doc-navigation. Distinguishing this kind from `doc` is what
 * prevents the post-reload regression where asset hrefs get stuffed into
 * bogus docNames (e.g. `notes/docs/meeting.pdf`).
 */
export interface AssetLinkTarget {
  kind: 'asset';
  url: string;
  ext: string;
  /**
   * Whether `url` is literal bytes (a wiki target names a file directly) or a
   * URI whose percent escapes decode (a markdown destination, per RFC 3986
   * §2.1). Both classifiers emit this same shape, so without the tag a
   * consumer holding one cannot tell which plane produced it and has to
   * re-derive the answer from context it may not have. Feed it straight to
   * `resolveAssetProjectPath`'s `literal` option.
   */
  literal: boolean;
}

export type ClassifiedLinkTarget =
  | DocLinkTarget
  | ExternalLinkTarget
  | AnchorLinkTarget
  | AssetLinkTarget;

/**
 * Compile-time exhaustiveness guard for `switch (target.kind)` consumers
 * over `ClassifiedLinkTarget`. Adding a new variant produces a TypeScript
 * error at every site that forgot to handle it (the new variant fails to
 * narrow to `never`). Per-DU helper rather than one shared `assertNever`
 * matches the codebase precedent (`assertNeverDiskEvent` in
 * `packages/server/src/file-watcher.ts`) and yields clearer error
 * messages.
 */
export function assertNeverLinkTarget(value: never): never {
  throw new Error(`Unhandled ClassifiedLinkTarget variant: ${JSON.stringify(value as unknown)}`);
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

/**
 * Extract a lowercased extension from a relative-path href (no scheme, no
 * fragment, no query). Returns null for extensionless paths. Anchor/query
 * stripped because extension lives before them.
 */
export function extractAssetExtension(href: string): string | null {
  const pathOnly = href.split(/[?#]/)[0] ?? href;
  const match = pathOnly.match(/\.([a-z0-9]+)$/i);
  return match ? (match[1] ?? '').toLowerCase() : null;
}

function splitDocNameSegments(docName: string): string[] {
  return docName.split('/').filter(Boolean);
}

export function isExternalHref(value: string): boolean {
  const trimmed = value.trim();
  return URI_SCHEME_RE.test(trimmed) || trimmed.startsWith('//');
}

export function classifyMarkdownHref(
  href: string,
  sourceDocName: string,
): ClassifiedLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    const anchor = trimmed.slice(1).trim();
    return anchor ? { kind: 'anchor', anchor } : null;
  }

  if (isExternalHref(trimmed)) {
    return { kind: 'external', url: trimmed };
  }

  // A skill bundle ref (`references/x`, `scripts/x`) inside a project SKILL doc
  // resolves into the skill dir, not the content root, so generic relative
  // resolution maps it to the wrong (nonexistent) doc and the link reads broken /
  // won't navigate. Apply the shared skill-bundle overlay (the same helper the
  // backlink index uses for `[[wiki]]` bundle refs) so markdown links reach the
  // real ref doc. Narrow by design: non-skill sources / non-bundle targets return
  // null and fall through unchanged.
  const hashAt = trimmed.indexOf('#');
  // Decode here, not inside the skill resolvers: those are shared with the
  // `[[wiki]]` path, whose targets are literal doc names and must stay
  // verbatim. An href is a URI on every branch, so it decodes on every branch —
  // otherwise a percent-encoded skill ref keeps resolving to a phantom doc.
  const bundlePath = decodeHrefPath(hashAt < 0 ? trimmed : trimmed.slice(0, hashAt));
  const bundleDoc = resolveSkillBundleWikiTarget(bundlePath, sourceDocName);
  if (bundleDoc) {
    return {
      kind: 'doc',
      docName: bundleDoc,
      anchor: hashAt < 0 ? null : trimmed.slice(hashAt + 1),
    };
  }

  // `/<skill-name>` inside a skill names a SIBLING SKILL, the way a slash
  // command names one — it is not a root-relative path. Skill bodies routinely
  // cross-reference each other that way, and read as a path it points at a
  // root doc that does not exist, so following one offered to create a page.
  const slashDoc = resolveSkillSlashTarget(bundlePath, sourceDocName);
  if (slashDoc) {
    return {
      kind: 'doc',
      docName: slashDoc,
      anchor: hashAt < 0 ? null : trimmed.slice(hashAt + 1),
    };
  }

  const internal = resolveInternalHref(trimmed, sourceDocName);
  if (internal) {
    return {
      kind: 'doc',
      docName: internal.docName,
      anchor: internal.anchor,
    };
  }

  // Relative path that didn't resolve as a markdown doc AND isn't an
  // external URL. If it has a non-markdown extension, treat it as an
  // asset reference — the click dispatcher will route it to a registered
  // viewer or OS delegation. Without this branch, post-reload clicks on
  // `![[meeting.pdf]]` fall back to `null` (unresolved) and end up
  // rendering as a broken doc-link.
  // Extension off the DECODED path, not the raw href: an escaped extension dot
  // (`./photo%2Ejpg`) only looks like an extension once the escape is resolved,
  // and reading it raw classifies the asset as a doc link. Same ordering
  // `resolveInternalHref`'s non-markdown guard uses, so the two agree on which
  // hrefs are assets.
  const ext = extractAssetExtension(bundlePath);
  if (ext && ext !== 'md' && ext !== 'mdx') {
    return { kind: 'asset', url: trimmed, ext, literal: false };
  }

  return null;
}

export function classifyWikiLinkTarget(
  target: string,
  anchor: string | null,
): DocLinkTarget | ExternalLinkTarget | AssetLinkTarget | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  if (isExternalHref(trimmed)) {
    return {
      kind: 'external',
      url: anchor ? `${trimmed}#${anchor}` : trimmed,
    };
  }

  const ext = extractAssetExtension(trimmed);
  if (ext && ext !== 'md' && ext !== 'mdx') {
    // A wiki target names a file literally: `[[100%20done.png]]` means a file
    // whose name really contains those three characters, so the target must
    // never be percent-decoded on its way to a filesystem path.
    return { kind: 'asset', url: trimmed, ext, literal: true };
  }

  return {
    kind: 'doc',
    docName: trimmed,
    anchor: anchor?.trim() || null,
  };
}

/**
 * Resolve a relative or server-absolute asset href to a project-root-
 * relative path.
 *
 * Three input shapes supported:
 *   - Relative, same-dir: `./meeting.pdf` → `<sourceDocDir>/meeting.pdf`
 *   - Relative, parent-walking: `../shared/photo.png` → resolves by
 *     walking the source doc's dirname
 *   - Server-absolute: `/vale_15.m4v` → stripped
 *     leading slash + resolved from project root. Emitted by the
 *     drop-time + post-roundtrip paths after the server-
 *     absolute URL fix so hash routing doesn't resolve against the wrong
 *     base.
 *
 * Used by the asset-click dispatcher's Electron branch (`shell.openAsset`
 * expects a project-relative path) and by the right-click context menu
 * builder. Mirrors `resolveInternalHref`'s path-walking logic but preserves
 * the file extension (non-md/mdx) rather than stripping it.
 *
 * Refuses paths that escape the project root — returns `null` if `..`
 * pops past the source doc's top-level directory (relative form) or
 * below the project root (server-absolute form). This is the renderer-
 * side "eager refusal" before IPC; the main-process
 * `isPathWithinProject` + `realpath` in `openAssetSafely` is the
 * authoritative defense-in-depth.
 *
 * Contract:
 *   - Input `href` MUST be non-empty, non-scheme (`http://`, `file://`,
 *     etc.), non-`//` (protocol-relative), non-anchor-only (`#foo`).
 *     These return `null`.
 *   - `#anchor` and `?query` suffixes are preserved in the input form
 *     but stripped from the returned project-relative path (the path is
 *     the canonical filesystem location; anchor/query are URL concerns).
 *   - Source doc at the root (no `/` in `sourceDocName`) with a relative
 *     `..` pop fails → returns `null`.
 *   - Server-absolute `/..` pops into negative territory → returns
 *     `null`.
 */
export interface ResolveAssetProjectPathOptions {
  /**
   * Treat the href as literal bytes rather than a URI: skip percent-decoding.
   * Wiki targets name a file directly, so `[[100%20done.png]]` means a file
   * whose name really contains `%20`; a markdown destination is a URI whose
   * escapes decode (RFC 3986 §2.1).
   *
   * REQUIRED, with no default, on purpose. Both classifiers emit the same
   * `{kind: 'asset', url}` shape, so the plane cannot be recovered here — the
   * caller that knows it must say so, and a caller that serves both planes has
   * to thread it from ITS caller rather than silently pick one. A default
   * would let a new call site inherit the wrong plane and report a working
   * link as dead. A caller holding a `ClassifiedLinkTarget` passes the
   * target's own `literal` rather than re-deriving it.
   */
  literal: boolean;
}

export function resolveAssetProjectPath(
  href: string,
  sourceDocName: string,
  options: ResolveAssetProjectPathOptions,
): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  // External URL schemes (http, https, file, mailto, etc.) — never a
  // project-relative asset.
  if (URI_SCHEME_RE.test(trimmed)) return null;
  // Protocol-relative (`//host/path`) — external origin, reject.
  if (trimmed.startsWith('//')) return null;
  // Anchor-only — no path component.
  if (trimmed.startsWith('#')) return null;

  // Strip anchor + query from the path portion (same-shape as
  // `resolveInternalHref`). The returned project-rel-path is a filesystem
  // location; the URL-layer concerns live on the original href.
  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const cleanPath = (pathPart.split('?')[0] ?? '').trim();
  if (!cleanPath) return null;

  // Server-absolute hrefs are project-root-relative: strip the leading
  // slash + start from an empty `dirParts` (not the source doc's dir).
  // Relative hrefs resolve against the source doc's dirname.
  const isServerAbsolute = cleanPath.startsWith('/');
  const effectivePath = isServerAbsolute ? cleanPath.slice(1) : cleanPath;
  const dirParts: string[] = isServerAbsolute
    ? []
    : sourceDocName.includes('/')
      ? sourceDocName.split('/').slice(0, -1)
      : [];

  for (const seg of effectivePath.split('/')) {
    if (seg === '..') {
      if (dirParts.length === 0) return null;
      dirParts.pop();
    } else if (seg !== '.' && seg !== '') {
      dirParts.push(options.literal ? seg : decodeHrefPathSegment(seg));
    }
  }

  if (dirParts.length === 0) return null;
  return dirParts.join('/');
}

// The link builders below append `DEFAULT_DOC_EXTENSION` (`.md`) when the
// caller doesn't know the target's real extension. `resolveInternalHref`
// strips `.md` and `.mdx` identically, so a `.md` href to an `.mdx` target
// still resolves correctly inside OK — the extension only matters for
// external-tool fidelity (GitHub / Obsidian / VS Code), where callers that DO
// know the target's extension thread it in.

export function buildRelativeMarkdownHref(
  sourceDocName: string,
  targetDocName: string,
  anchor: string | null = null,
  ext: string = DEFAULT_DOC_EXTENSION,
): string {
  const sourceDirSegments = splitDocNameSegments(sourceDocName);
  sourceDirSegments.pop();

  const targetSegments = splitDocNameSegments(targetDocName);

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < sourceDirSegments.length &&
    commonPrefixLength < targetSegments.length &&
    sourceDirSegments[commonPrefixLength] === targetSegments[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  const upSegments = sourceDirSegments.slice(commonPrefixLength).map(() => '..');
  const downSegments = targetSegments.slice(commonPrefixLength);
  let relativePath = [...upSegments, ...downSegments].join('/');

  relativePath ||= targetSegments.at(-1) ?? targetDocName;

  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    relativePath = `./${relativePath}`;
  }

  // The path is escaped but the anchor is not: `resolveInternalHref` decodes the
  // path portion and returns the fragment verbatim, so encoding the fragment here
  // would break that symmetry.
  return `${encodeHrefPath(relativePath)}${ext}${anchor ? `#${anchor}` : ''}`;
}

/**
 * Build a root-absolute markdown href (leading slash = content root) for a
 * doc. The context-free canonical form: it resolves to `docName` from ANY
 * source doc, so a caller that doesn't know a current authoring doc emits this
 * shape.
 */
export function buildAbsoluteMarkdownHref(
  docName: string,
  ext: string = DEFAULT_DOC_EXTENSION,
  anchor: string | null = null,
): string {
  return `/${encodeHrefPath(docName)}${ext}${anchor ? `#${anchor}` : ''}`;
}
