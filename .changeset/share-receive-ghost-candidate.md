---
"@inkeep/open-knowledge-desktop": patch
---

Fix: opening a share link no longer offers to initialize a folder that is no longer a git checkout. If a project was moved or deleted outside OK, its recents entry could still be presented as the share target with a "this branch is checked out in <path>" claim and an "Initialize it and open?" prompt, because the path still existed on disk. Share receive now requires a candidate to be a real git working tree at that exact path, so a stale entry falls through to the launcher's "Clone from GitHub" / "I already have it locally" choices instead. Stale entries also no longer suppress worktree enumeration, so a share whose branch is checked out in a linked worktree now opens that worktree directly rather than prompting to switch branches.
