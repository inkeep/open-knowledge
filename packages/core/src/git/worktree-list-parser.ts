/**
 * Pure parser for `git worktree list --porcelain` output. Reverse of the
 * format documented at https://git-scm.com/docs/git-worktree#_porcelain_format —
 * one block per worktree, blank-line separated, with stable key=value lines
 * (`worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` OR `detached`,
 * optional `locked [reason]`, optional `prunable <reason>`).
 *
 * Used by the desktop main process's `listGitWorktrees` IPC handler to
 * enumerate worktrees beyond the OK Recents list. The IPC handler shells out
 * to `git worktree list --porcelain` from an anchor path inside the target
 * repo, then runs this parser on the stdout to get a typed array. Keeping the
 * parser pure (no IO, no spawning, no global state) lets it ship in `core`
 * and stay unit-testable without a git fixture.
 *
 * Tolerance is the load-bearing property here: future versions of git may add
 * new porcelain keys, and we don't want a forward-compat addition to crash
 * the receive flow. Unknown keys are ignored. Malformed blocks (no `worktree`
 * line, or a `worktree` line without a path argument) are skipped — the
 * parser returns the well-formed entries and never throws.
 */

/**
 * One parsed entry from `git worktree list --porcelain`.
 *
 * `path` is whatever git reported (absolute on every git version we support;
 * the IPC handler applies `realpathSync` upstream for canonical-path
 * identity collapse).
 * `branch` is the short ref (`feat-foo`, `feat/foo/bar`), with the
 * `refs/heads/` prefix already stripped. `null` when the worktree is in a
 * detached-HEAD state. `headSha` is `null` only when git omitted the `HEAD`
 * line entirely (unusual — every worktree git knows about has a HEAD).
 */
export interface BridgeWorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
}

const REFS_HEADS_PREFIX = 'refs/heads/';

/**
 * Parse `git worktree list --porcelain` stdout into a typed array. Empty
 * stdout returns `[]`. Malformed blocks are skipped without throwing — the
 * parser returns the well-formed entries and lets the caller decide whether
 * the partial result is usable.
 */
export function parseWorktreeListPorcelain(stdout: string): BridgeWorktreeEntry[] {
  if (stdout.length === 0) return [];

  const entries: BridgeWorktreeEntry[] = [];
  let current: MutableEntry | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.length === 0) {
      // Blank line terminates a block. Multiple consecutive blank lines are
      // tolerated — `current === null` short-circuits this branch.
      if (current !== null) {
        const finalized = finalizeBlock(current);
        if (finalized !== null) entries.push(finalized);
        current = null;
      }
      continue;
    }

    const sepIndex = line.indexOf(' ');
    const key = sepIndex === -1 ? line : line.slice(0, sepIndex);
    const value = sepIndex === -1 ? '' : line.slice(sepIndex + 1);

    if (key === 'worktree') {
      // A new `worktree` line implicitly terminates the previous block — guard
      // against ill-formed output that drops the separating blank line.
      if (current !== null) {
        const finalized = finalizeBlock(current);
        if (finalized !== null) entries.push(finalized);
      }
      current = value.length > 0 ? createBlock(value) : null;
      continue;
    }

    // Out-of-block keys (a `HEAD` line before any `worktree` line, or a stray
    // `locked` after a blank line) are silently dropped — there's no
    // meaningful semantics to attach them to. `current === null` short-circuits.
    if (current === null) continue;

    switch (key) {
      case 'HEAD':
        current.headSha = value.length > 0 ? value : null;
        break;
      case 'branch':
        current.branch = stripRefsHeads(value);
        break;
      case 'detached':
        // `detached` has no value; presence flips branch back to `null` even if
        // a preceding `branch` line was emitted (git won't do this, but the
        // tolerance is cheap insurance).
        current.branch = null;
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        // git emits `locked` optionally followed by a reason on the same line.
        // We don't surface the reason today (no spec consumer); flip the flag.
        break;
      case 'prunable':
        current.prunable = true;
        break;
      default:
        // Unknown key — forward-compat: ignore without warning.
        break;
    }
  }

  // Trailing block without a blank-line terminator (single-worktree repos
  // sometimes emit no trailing newline).
  if (current !== null) {
    const finalized = finalizeBlock(current);
    if (finalized !== null) entries.push(finalized);
  }

  return entries;
}

interface MutableEntry {
  path: string;
  branch: string | null;
  headSha: string | null;
  locked: boolean;
  prunable: boolean;
  detached: boolean;
}

function createBlock(path: string): MutableEntry {
  return { path, branch: null, headSha: null, locked: false, prunable: false, detached: false };
}

/**
 * Finalize a partial block into a `BridgeWorktreeEntry`. Returns `null` when
 * the block lacks the required `worktree <path>` line — guards against
 * malformed input emitting an empty entry.
 */
function finalizeBlock(block: MutableEntry): BridgeWorktreeEntry | null {
  if (block.path.length === 0) return null;
  return {
    path: block.path,
    branch: block.branch,
    headSha: block.headSha,
    locked: block.locked,
    prunable: block.prunable,
  };
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith(REFS_HEADS_PREFIX) ? ref.slice(REFS_HEADS_PREFIX.length) : ref;
}
