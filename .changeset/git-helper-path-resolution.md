---
"@inkeep/open-knowledge": patch
---

Opening a shared branch in a worktree (and other git operations) no longer fails with a generic error when the repository uses git-lfs installed via Homebrew. The desktop app and its server now append well-known tool directories (Homebrew, MacPorts, `~/.local/bin`, asdf/mise shims) to the PATH used for git commands, so helpers git spawns mid-operation — LFS filters, credential helpers, hooks — resolve even though macOS launches apps with a minimal PATH. When a required helper still can't be found, the error now names it ("Git needs git-lfs…") instead of a retry-blind generic message, and the underlying git error is recorded in the desktop log.
