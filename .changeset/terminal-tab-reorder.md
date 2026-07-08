---
"@inkeep/open-knowledge": minor
---

Reorder terminal tabs. Drag a terminal tab to a new position with the pointer, or
move the active tab with ⌘⇧← / ⌘⇧→ (keyboard reorders are announced to screen
readers). Untitled tabs now carry a sticky number that stays with the session, so
reordering them is visibly meaningful instead of silently renumbering, and ⌘1–9
still jumps to the tab at that visual position. The drag reuses the editor's tab
chrome, and in the standalone terminal window a drag across the tab strip reorders
tabs instead of moving the window. Your custom names and tab order are retained by
the main process, so a renderer reload (View → Reload) restores both names and
order; a full app quit still starts fresh, since the shells themselves don't
survive a restart.
