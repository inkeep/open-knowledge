---
"@inkeep/open-knowledge": minor
---

Opening a share link whose target moved or vanished now gives an honest, cause-specific answer instead of a misleading "not on this branch yet." When the shared doc or folder is missing on your current branch, the branch-switch dialog checks GitHub and tells you what actually happened: if it was just added to the branch, "Switch and update branch" fast-forwards your local branch and opens it; if it moved, you're offered to open it at its new path; if it was removed, you're told so plainly; and if it was never pushed, you're told that distinctly (never "removed"). If your local branch has diverged from GitHub, the update is refused and a plain switch is offered with an honest note — the receive flow never merges or rebases, leaving reconciliation to sync. When the check can't reach GitHub, it falls back to today's behavior.
