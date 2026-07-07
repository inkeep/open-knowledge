/**
 * Auto-location policy for OK-managed worktrees (worktrees live inside
 * the project, gitignored). A worktree for `<branch>` is created at
 * `<mainRoot>/.ok/worktrees/<branch>`. `.ok/` is OK's state directory —
 * already outside the content scope and easy to exclude from the parent repo's
 * git status — so a nested worktree never pollutes the parent project's
 * indexing or working tree.
 *
 * The sanitizer is defense-in-depth: `git worktree add -b <branch>` already
 * rejects illegal ref names (`git check-ref-format`), but we build the target
 * PATH from the branch before handing it to git, so we validate here that the
 * branch can never resolve outside the `.ok/worktrees/` sandbox.
 */

/** Parent directory (relative to the main worktree root) holding all worktrees. */
export const WORKTREES_PARENT_DIR = '.ok/worktrees';

/**
 * Map a branch name to its relative worktree directory under the main root, or
 * `null` when the branch can't be represented as a safe relative path. Branch
 * names may contain `/` (git namespaces) — those become nested directories,
 * which `git worktree add` creates. Rejects any segment that could escape the
 * sandbox (`..`, `.`, empty, leading/trailing slash, backslash, NUL).
 */
export function worktreeRelativeDir(branch: string): string | null {
  const trimmed = branch.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..') return null;
    if (seg.includes('\\') || seg.includes('\0')) return null;
  }
  return `${WORKTREES_PARENT_DIR}/${trimmed}`;
}
