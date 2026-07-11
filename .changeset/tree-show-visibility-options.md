---
"@inkeep/open-knowledge": minor
---

The file tree gains a "Show" visibility menu. The tree-options button in the
sidebar toolbar (now always visible) opens a two-section popover: the existing
Expand all / Collapse all commands, and a new Show group with four checkboxes:
Hidden files, .ok folders, Only markdown files, and Skills. The same toggles
appear in the sidebar right-click menu and the macOS View menu, and every
surface stays in sync. Preferences persist per project per machine.

- "Only markdown files" strips the tree to just your .md/.mdx documents and
  folders, for a focused notes view.
- ".ok folders" reveals OpenKnowledge's own project state (skills, templates,
  config) in place, read-only: clicks route to the Skills editor, the template
  editor, or a read-only viewer, and internal `worktrees/` and `local/`
  directories are never listed. Search is unaffected by the reveal.
- "Skills" hides or shows the sidebar Skills section.
- Opening a doc the tree currently hides (via a link, search, or URL) now
  leaves the tree quiet: no stale row stays highlighted and the tree no longer
  scrolls to the wrong row (two pre-existing defects fixed). A subtle editor
  indicator names which toggles hide the current doc, with one-click flips.
- When active filters hide everything, the tree explains itself and offers a
  one-click "Reset view filters".
