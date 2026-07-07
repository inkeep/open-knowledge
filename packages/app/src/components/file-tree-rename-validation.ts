/**
 * Pure validation + coercion for sidebar inline-rename payloads from Pierre.
 *
 * Pierre's RenameInput hands the full filename to the user (basename + ext).
 * Document rows keep their source extension when the user commits a basename
 * only. Explicit extensions are preserved verbatim: `.md` ↔ `.mdx` stays on
 * the managed-document path, and `.md`/`.mdx` → any other extension is routed
 * as a document-to-file rename by the caller.
 *
 * MUST operate on the RAW event paths from Pierre (before
 * `normalizeTreePathForKind`), because that normalizer silently appends `.md`
 * to anything that doesn't already end in `.md` / `.mdx` — which would mask
 * the user's "I tried to change the extension" intent into `.tx.md`.
 *
 * Asset rows allow explicit extension changes, but still reattach the source
 * extension when the destination is basename-only.
 */

type RenameDestinationValidation = { kind: 'allow'; destinationPath: string };
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx']);

/**
 * Return the file extension (including the leading dot) for a path. Returns
 * the empty string for paths with no extension, or for dotfiles like
 * `.gitignore` where the leading dot is part of the name, not an extension.
 */
export function getFileExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const basename = lastSlash < 0 ? path : path.slice(lastSlash + 1);
  const lastDot = basename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return basename.slice(lastDot);
}

/**
 * Return `path` with its file extension replaced by `newExt`. If the basename
 * has no detected extension (or is a dotfile), `newExt` is appended to the
 * basename. Directory portion is preserved verbatim.
 */
export function replaceFileExtension(path: string, newExt: string): string {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash < 0 ? '' : path.slice(0, lastSlash + 1);
  const basename = lastSlash < 0 ? path : path.slice(lastSlash + 1);
  const lastDot = basename.lastIndexOf('.');
  const basenameNoExt = lastDot <= 0 ? basename : basename.slice(0, lastDot);
  return `${dir}${basenameNoExt}${newExt}`;
}

export function hasSupportedDocumentExtension(path: string): boolean {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(getFileExtension(path).toLowerCase());
}

export function validateAndCoerceRenameDestination(
  sourcePath: string,
  destinationPath: string,
  isFolder: boolean,
): RenameDestinationValidation {
  if (isFolder) return { kind: 'allow', destinationPath };
  const sourceExt = getFileExtension(sourcePath);
  // Source has no extension (e.g., a dotfile) — nothing to preserve.
  if (sourceExt === '') return { kind: 'allow', destinationPath };
  const destExt = getFileExtension(destinationPath);
  return {
    kind: 'allow',
    destinationPath: destExt ? destinationPath : replaceFileExtension(destinationPath, sourceExt),
  };
}
