---
"@inkeep/open-knowledge": patch
---

Fixes `Backspace`/`Delete` at a list-item boundary orphaning rows (inkeep/open-knowledge#609). Merging two list items — e.g. backspacing at the start of a checked task item into the item above, or deleting forward across a nested/top-level boundary — could leave the merged text as a bare paragraph with no bullet or checkbox, or silently re-nest it at the wrong depth. Backspace and Delete now merge the two items' text directly, keeping the surviving item's list marker and nesting intact.
