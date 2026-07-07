---
"@inkeep/open-knowledge": minor
---

A new **Terminal → New Terminal Window** command opens a terminal in its own dedicated window, so you can keep a full-height shell alongside the editor instead of sharing the docked panel's vertical space.

- The window reuses the docked terminal's multi-session tabs: open more shells with the `+` affordance, switch with ⌘-number, and each tab is its own login shell. The ⌘-number chord is always active here since the whole window is the terminal.
- Launched from a project, the window inherits that project's cwd and config (its shells start at the project root); launched with no project focused, it opens a shell at your home directory.
- Open it as many times as you like — each invocation is an independent window with its own terminal host, including multiple windows for the same project.
- Closing the last tab closes the window, and closing a window reaps all of its shells (no orphaned processes).

The command matches VS Code's "New Terminal Window" and ships without a keyboard shortcut; ⌘J stays the docked Show/Hide Terminal toggle. The docked terminal is unchanged, and the security posture is the same: terminals remain human-only and default-on, with no new IPC surface.
