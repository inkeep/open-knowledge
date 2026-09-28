---
"@inkeep/open-knowledge": patch
---

Publishing to GitHub no longer copies your token into other credential stores, and `ok sync` without the app uses the app's GitHub sign-in. If a private `ok clone`, your own `git` or the app's **Open in worktree** used that copy, set up Git credentials, for example with `gh auth setup-git`.
