---
"@inkeep/open-knowledge": minor
---

Share links for a branch you don't have checked out now default to opening in a worktree. The branch-mismatch dialog's primary action, "Open in worktree", creates (or reuses) the branch's worktree under `.ok/worktrees/<branch>` and opens it in its own window at the shared doc or folder — your current checkout, branch, and uncommitted changes stay exactly where they were. Switching the current window's branch is still available as "Switch branch", with unchanged behavior including the post-checkout navigation gate.

This also un-dead-ends the dirty-conflict case: where uncommitted changes used to block the share entirely ("commit or stash, then open the link again"), the worktree action now works immediately. The share branch resolves wherever it lives — an existing local branch, a remote-tracking ref, or never fetched, in which case a bounded `git fetch origin <branch>` (15s cap, no credential prompts) runs first. Failures stay honest: a branch deleted upstream dismisses the dialog with the existing "no longer exists" notice, a connection failure keeps it open so you can retry or pick another action, and the new window inherits the target-existence check, so a stale branch shows the honest missing-target panel instead of silently creating an empty doc. New worktrees appear in the worktree switcher immediately.
