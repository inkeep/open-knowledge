---
"@inkeep/open-knowledge": patch
---

Agents started from the desktop app now launch even when their CLI was installed through a JavaScript package manager's global bin (pnpm, bun, Volta, Yarn, or npm's user prefix). A desktop app opened from the Dock or Finder inherits a minimal `PATH` that omits locations like `~/Library/pnpm` and `~/.bun/bin`, so an agent such as Pi that ran fine in a terminal would fail to start with a "command not found" error. Agent and terminal launches now append the well-known tool directories and package-manager global bins to `PATH` — the same approach already used for git — so these agents start correctly. When a command still can't be found, the error now explains that Dock/Finder-launched apps don't see your shell's `PATH`.
