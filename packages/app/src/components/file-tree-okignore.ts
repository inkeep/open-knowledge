/**
 * Build an anchored gitignore pattern from a `treeItemToTarget` result, for
 * the FileTree right-click "Hide this file/folder" action. The pattern is
 * anchored to the project root (leading `/`) so it matches the exact entry
 * the user right-clicked, not every file in the workspace with that name.
 *
 * For files, the on-disk path includes the extension; `target.path` strips
 * it, so we re-attach `target.docExt` —
 * defaulting to `.md` for entries that don't carry an explicit extension.
 * For folders, append `/` so the pattern matches files inside the folder
 * rather than a file with the same name.
 *
 * Glob metacharacters (`[`, `]`, `*`, `\`) in the path are backslash-escaped
 * so the resulting pattern matches the literal file the user clicked,
 * rather than being parsed as a character class or wildcard. `?` is
 * deliberately not escaped: npm:ignore does not honor `\?`, so an escaped
 * `?` would silently fail to hide the file at all; the unescaped form
 * still hides the user's file (along with same-stem siblings, which the
 * user can correct from Settings).
 */
interface OkignoreFileTreeTarget {
  kind: 'file' | 'folder';
  path: string;
  docExt?: string;
}

function escapeGitignoreLiteral(s: string): string {
  // Escape backslash first so subsequent inserted backslashes aren't doubled.
  return s.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\*/g, '\\*');
}

export function buildOkignorePatternFromTarget(target: OkignoreFileTreeTarget): string {
  const path = escapeGitignoreLiteral(target.path);
  if (target.kind === 'folder') {
    return `/${path}/`;
  }
  const ext = target.docExt ?? '.md';
  return `/${path}${ext}`;
}
