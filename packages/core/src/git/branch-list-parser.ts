/**
 * Pure parser for `git for-each-ref --format='%(refname:short)' refs/heads/`
 * output (one local branch short-name per line). Sibling of
 * `worktree-list-parser.ts` — both feed the desktop worktree selector, and both
 * stay in `core` so they're unit-testable without a git fixture.
 *
 * Tolerance is the load-bearing property: blank lines, trailing whitespace, and
 * a missing trailing newline are all handled. Order is preserved as git emits
 * it (which is refname-sorted for `for-each-ref`) so the caller can rely on a
 * stable enumeration.
 */

/**
 * Parse newline-separated branch short-names into a de-duplicated, order-
 * preserving array. Empty / whitespace-only lines are dropped. Never throws.
 */
export function parseBranchList(stdout: string): string[] {
  if (stdout.length === 0) return [];

  const seen = new Set<string>();
  const branches: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const branch = rawLine.replace(/\r$/, '').trim();
    if (branch.length === 0 || seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}
