/**
 * Pure validation + coercion for sidebar inline-rename payloads from Pierre.
 *
 * Pierre's RenameInput hands the full filename to the user (basename + ext).
 * Document rows keep their source extension when the user commits a basename
 * only. Explicit extensions are preserved verbatim: `.md` ↔ `.mdx` stays on
 * the managed-document path, and `.md`/`.mdx` → any other extension is routed
 * as a document-to-file rename by the caller. The one exception is a typed
 * document extension onto which the retained source extension stacks a second
 * one (`.md.md`, but equally `.md.mdx`) — see
 * `collapseDoubledDocumentExtension`.
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

/**
 * Drop a retained source extension that the user's own typed extension already
 * supplied. Pierre pre-selects only the stem, so typing a whole filename ending
 * in `.md` commits what was typed FOLLOWED by the still-present suffix.
 *
 * The doubled path is not merely ugly: `name.md.md` carries docName `name.md`,
 * and `docNameToTreePath` returns any docName already ending in `.md`/`.mdx`
 * verbatim — so the doubled file and a real `name.md` resolve to one tree path,
 * and persistence writes the doubled file's document to the other file's name.
 *
 * Scoped to document sources whose remainder is itself a document extension —
 * that pairing is what breaks the bijection. Genuine dotted names (`v1.2.md`,
 * `report.2026.md`) keep their suffix, and asset renames are left alone
 * entirely for two separate reasons: `photo.png.png` maps to a tree path
 * verbatim with no docName round-trip to break, and collapsing `notes.md.png`
 * would silently retitle an image to the document extension the user happened
 * to type.
 *
 * Exactly one retained layer comes off; this is not a general doubled-extension
 * sanitizer. A destination the user deliberately typed with its own doubled
 * suffix keeps what remains (`v1.md.md.md` → `v1.md.md`), and a stem-less
 * `.md.md` is left intact because its docName is `.md`, which carries no
 * strippable extension and so still resolves back to that same file.
 */
function collapseDoubledDocumentExtension(destinationPath: string, sourceExt: string): string {
  if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(sourceExt.toLowerCase())) return destinationPath;
  if (!destinationPath.endsWith(sourceExt)) return destinationPath;
  const withoutRetainedExt = destinationPath.slice(0, -sourceExt.length);
  return hasSupportedDocumentExtension(withoutRetainedExt) ? withoutRetainedExt : destinationPath;
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
    destinationPath: destExt
      ? collapseDoubledDocumentExtension(destinationPath, sourceExt)
      : replaceFileExtension(destinationPath, sourceExt),
  };
}
