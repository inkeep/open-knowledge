---
"@inkeep/open-knowledge": patch
---

Fixes Backspace/Delete merges at nested list-item boundaries (inkeep/open-knowledge#609). Backspace at the start of an item whose previous sibling has a nested sublist no longer lifts the item out of the list as a bare paragraph with no bullet or checkbox, and forward Delete at the end of a nested item before a shallower item no longer re-nests that item at the wrong depth or silently drops its checkbox. Both fixes cover the Mod-Backspace/Mod-Delete variants; flat-list merges, first-item lift-out, and autoformat undo behavior are unchanged. Supersedes and credits inkeep/open-knowledge#613 by @blokboy.
