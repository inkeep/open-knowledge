/**
 * Pure helpers for the filename + extension picker used by NewItemDialog and
 * the FileTree rename flow.
 *
 * Canonical extension list mirrors `packages/server/src/doc-extensions.ts`
 * `SUPPORTED_DOC_EXTENSIONS`. Kept as a client-local constant because core /
 * app UI can't import from server. UI-default order is `.md` first because
 * that's the historical default for new files; server-side precedence is
 * reversed (`.mdx` wins when both exist on disk) and is handled server-side.
 */

export const SUPPORTED_EXTENSIONS = ['.md', '.mdx'] as const;
export type DocExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export function isDocExtension(value: string): value is DocExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * Detect a supported extension at the tail of a path. Returns the canonical
 * lowercase form so callers can safely compare with `===`. Matches are
 * anchored — `foo.md.txt` returns null, not `.md`.
 */
export function detectExtension(path: string): DocExtension | null {
  const lower = path.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

/**
 * Strip a supported extension from the tail of a path. No-op when no
 * supported extension is present.
 */
export function stripExt(path: string): string {
  const ext = detectExtension(path);
  return ext ? path.slice(0, -ext.length) : path;
}
