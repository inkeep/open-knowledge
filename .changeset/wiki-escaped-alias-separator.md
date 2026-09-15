---
'@inkeep/open-knowledge': patch
---

Wiki links and embeds written with an escaped alias separator (`[[Page\|Alias]]`, required inside tables) now resolve to a clean target, anchor, and alias instead of one ending in a stray backslash; the escape you authored stays in the file. Escape-only or whitespace targets are no longer links.
