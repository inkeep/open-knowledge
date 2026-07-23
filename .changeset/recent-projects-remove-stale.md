---
"@inkeep/open-knowledge": patch
---

Recent projects can now be removed from the desktop app, matching VS Code's "Open Recent" behavior. Recents in the sidebar "Switch project" dropdown and the command palette gain a hover "×" and a right-click "Remove from recent projects" action; the Project Navigator keeps its per-row "×" and now offers the same right-click action. Removing an entry also clears its saved editor session and window position, not just the list row.

Opening a recent whose folder was deleted or moved outside the app no longer leaves a dead entry behind. The app detects the gone folder on open, drops the stale entry from the list, and shows a brief notice instead of failing to open a window. Missing recents are no longer greyed out or tagged; they stay openable and self-clean on open. Only a folder that is genuinely gone is pruned this way: a folder that is merely unreadable for the moment (a permission-restricted parent) stays in the list.
