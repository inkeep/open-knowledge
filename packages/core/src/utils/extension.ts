/**
 * Shared extension-extraction helper used by the client emit path,
 * the wiki-link-embed render path, and the mdast→PM dispatch. Three
 * implementations shipped slightly divergent before consolidation —
 * same-ish behavior for typical inputs, different behavior for
 * `v1.0/README` (image-upload returned `0/README`, the others returned
 * `README`). Consistency matters: the mdast→PM handler and the render
 * path both consume the extension to pick the PM shape, so the two
 * must agree on what "extension" means for a given input.
 *
 * Behavior (covers both filename and path inputs):
 *   - Strip directories first (`subdir/foo.png` → `foo.png`).
 *   - `lastIndexOf('.')` on the remaining basename.
 *   - Trailing dot (`foo.`) counts as no-extension.
 *   - Leading dot on a dotfile (`.gitignore`, `.png`) counts as
 *     no-extension (the `<= 0` branch below).
 *   - Lowercase the result for case-insensitive matching.
 *
 * NOTE on `idx <= 0` vs `idx < 0`:
 *   The consolidation unified three divergent helpers; two of the
 *   pre-fix implementations (`wiki-link-embed.ts`, `markdown/index.ts`)
 *   used `idx < 0 || idx === basename.length - 1`, which would treat
 *   `.gitignore` as extension=`gitignore`. The third (`image-upload`)
 *   used `idx === -1`, likewise returning `gitignore`. The consolidated
 *   `<= 0` branch deliberately tightens all three to treat leading-dot
 *   names as hidden dotfiles WITH NO EXTENSION — matches POSIX intuition
 *   (a `.png` hidden dotfile is
 *   content the user manually added, not a file they dropped expecting
 *   image rendering). Consumers that want to distinguish `.png` (hidden)
 *   from `photo.png` (extension-typed) need their own logic — this
 *   helper does not surface dotfile-ness separately from extension
 *   presence.
 */
export function extensionOf(filenameOrPath: string): string {
  const basename = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const idx = basename.lastIndexOf('.');
  // `idx <= 0` covers both "no dot at all" (-1) and "dot is at position
  // 0" (hidden dotfile). Do NOT flip to `< 0`: `.gitignore` → ext
  // `gitignore` would feed the `wikiEmbedExtensions` allowlist check
  // with nonsense values AND subtly change drop dispatch for literal
  // dotfiles.
  if (idx <= 0 || idx === basename.length - 1) return '';
  return basename.slice(idx + 1).toLowerCase();
}
