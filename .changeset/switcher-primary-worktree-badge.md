---
'@inkeep/open-knowledge-app': patch
---

The project switcher's worktree flyout no longer labels a row `default`. That word means a repository's default branch everywhere else in git tooling, but the flyout was using it for the original clone, so checking out a feature branch there made the switcher claim that branch was your default while your real default branch sat further down the list offered as one to create a worktree for. Rows now say where each branch is checked out instead: `primary` for the original clone, `worktree` for a linked worktree, and the unchanged `create worktree` for branches without one. Both location badges carry a hover description naming the directory.
