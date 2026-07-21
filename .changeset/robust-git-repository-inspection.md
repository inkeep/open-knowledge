---
"@inkeep/open-knowledge": patch
---

Local Git-backed workflows now inspect repositories consistently across the `ok` CLI, Desktop, and the collaboration server. This removes several places where each surface parsed `.git`, `HEAD`, refs, and remotes differently.

- Linked worktrees now read `HEAD` from the worktree-specific Git directory while reading remotes, refs, and clone-wide excludes from the shared common Git directory. Folder validation, share-receive matching, branch display, and `ok config-sharing` therefore work the same in a linked worktree as in a primary checkout.
- Shadow-repository setup now recognizes the nearest enclosing repository when an OpenKnowledge project is rooted in a subdirectory, while still refusing to promote a repository rooted at the user's home directory.
- Branch and remote inspection now handles loose and packed refs, symbolic refs, SHA-1 and SHA-256 object IDs, relative or absolute worktree pointers, and quoted or commented remote configuration through one shared implementation.
- Missing refs, malformed metadata, stale worktree pointers, inaccessible Git files, and unsafe ref paths are classified separately so sync and branch-watching code can fail safely instead of treating every read problem as a missing branch.
- Branch-switch conflict checks now wait for both Git probes to finish before returning an invalid-target error, preventing a leftover child process from racing repository cleanup.

No configuration or migration is required.
