/**
 * Workspace path utilities shared across surfaces that construct absolute
 * filesystem paths (sidebar "Copy path > Full path", handoff dispatch
 * inputs, etc.). EditorHeader + CommandPalette + FileTree all build
 * `HandoffDispatchInput.docPath` through these helpers so a second
 * normalizer doesn't appear.
 */

/**
 * Workspace root + OS path separator as advertised by the server.
 *
 * `contentDir` is an absolute, realpath-resolved path (see `handleWorkspace`
 * in `packages/server/src/api-extension.ts`). `pathSeparator` is Node's
 * `path.sep` for the server process — `/` on POSIX hosts, `\\` on Windows —
 * and is the source of truth because the shape of `contentDir` alone does not
 * disambiguate all cross-platform cases (e.g. a POSIX folder name containing
 * a literal backslash).
 */
export interface Workspace {
  readonly contentDir: string;
  readonly pathSeparator: '/' | '\\';
}

/**
 * Join `contentDir` with a workspace-relative path using the advertised
 * separator. `relative` is accepted in POSIX form (forward slashes) — the
 * shape used by `DocEntry.docName`, sidebar tree paths, and CRDT document
 * identifiers — and rewritten to backslashes only on Windows.
 *
 * Mirrors how paths appear in git diffs, VS Code "Copy Relative Path", and
 * the server's docName convention.
 */
export function joinWorkspacePath(contentDir: string, relative: string, sep: '/' | '\\'): string {
  const normalizedRelative = sep === '\\' ? relative.replaceAll('/', '\\') : relative;
  const trimmedDir = contentDir.endsWith(sep) ? contentDir.slice(0, -1) : contentDir;
  return `${trimmedDir}${sep}${normalizedRelative}`;
}

/**
 * Convert an extension-less docName (e.g. `specs/foo/SPEC`) to its `.md`-
 * suffixed relative-path form (e.g. `specs/foo/SPEC.md`).
 *
 * Assumes all docs use the `.md` extension. An `.mdx` document present in
 * the content directory would still report its docName without the extension;
 * callers that need true-extension resolution would need a new `/api/documents`
 * field.
 */
export function docNameToRelativePath(docName: string): string {
  return `${docName}.md`;
}
