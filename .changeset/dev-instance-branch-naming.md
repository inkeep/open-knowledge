---
"@inkeep/open-knowledge-desktop": patch
---

Dev: desktop `dev` launches now auto-isolate per git worktree/branch. Each launch derives its instance name from the checkout (branch name, or worktree directory on a detached HEAD) and relocates `userData` to a named sibling, so running `dev` from two worktrees at once no longer loses the single-instance lock. The instance name is shown in a branch badge in the editor top toolbar and as a Dock badge, alongside the existing menu-bar name and window titles. The default branch (`main`/`master`) is skipped; `OK_INSTANCE=<name>` overrides the derived name and `OK_AUTO_INSTANCE=0` disables auto-derivation. Unpackaged builds only; packaged releases are unaffected.
