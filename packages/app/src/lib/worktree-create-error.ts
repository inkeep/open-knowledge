import type { WorktreeCreateResult } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

type WorktreeCreateFailure = Extract<WorktreeCreateResult, { readonly ok: false }>;
type WorktreeCreateErrorInput =
  | {
      readonly reason: 'project-scope-unavailable';
      readonly issue: Extract<
        WorktreeCreateFailure,
        { readonly reason: 'project-scope-unavailable' }
      >['issue'];
    }
  | {
      readonly reason: Exclude<WorktreeCreateFailure['reason'], 'project-scope-unavailable'>;
    };

export function worktreeCreateErrorCopy(result: WorktreeCreateErrorInput): MessageDescriptor {
  switch (result.reason) {
    case 'branch-exists':
      return msg`A branch with that name already exists. Open its worktree from the switcher instead.`;
    case 'already-checked-out':
      return msg`That branch is already open in another worktree.`;
    case 'path-exists':
      return msg`A worktree folder for that branch already exists.`;
    case 'invalid-branch':
      return msg`Enter a valid branch name (no spaces, no leading dot, no "..").`;
    case 'no-git':
      return msg`This project isn't a git repository, so worktrees aren't available.`;
    case 'empty-repo':
      return msg`This project has no commits yet, so there's no branch to base a worktree on. Make a first commit, then try again.`;
    case 'helper-not-found':
      return msg`Git needs a helper tool (such as git-lfs) that isn't installed or couldn't be found. Install it, then try again.`;
    case 'project-scope-unavailable':
      switch (result.issue) {
        case 'missing':
          return msg`This branch does not contain this OpenKnowledge project. The worktree was created but not opened.`;
        case 'unreadable':
          return msg`The OpenKnowledge project path on this branch cannot be read. The worktree was created but not opened.`;
        case 'outside-worktree':
          return msg`The OpenKnowledge project path on this branch leaves the worktree. The worktree was created but not opened.`;
        case 'unsafe-setup-path':
          return msg`This branch redirects an OpenKnowledge setup path outside the worktree. The worktree was created but not opened.`;
        case 'setup-failed':
          return msg`OpenKnowledge couldn't finish setting up this project. The worktree was created but not opened.`;
        default: {
          const exhaustive: never = result.issue;
          throw new Error(`Unhandled project scope issue: ${String(exhaustive)}`);
        }
      }
    default:
      return msg`Couldn't create the worktree. Try a different name.`;
  }
}
