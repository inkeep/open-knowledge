---
"@inkeep/open-knowledge": patch
---

Fix the branch-mismatch share dialog ("Open shared document") overflowing its modal when the shared branch has a long name. The switch action used to embed the full branch name ("Switch to `<branch>`"), which pushed the button row past the dialog edge and clipped the primary "Open in worktree" button. The action now reads simply "Switch branch" — the branch name is already shown in the dialog's Branch row and body — and the footer's action group wraps instead of overflowing when all three actions (Open in current branch / Switch branch / Open in worktree) are present.
