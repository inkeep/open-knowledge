---
'@inkeep/open-knowledge': patch
---

Keep the suggestion pickers inside the editor pane

The slash, wiki-link and tag pickers are fixed-width — the slash menu is two columns totalling about 490px — so a pane narrowed by a docked terminal or agents rail could not hold them and they painted over the dock, the same escape the formatting bar and comment composer were just fixed for. They now cap their width to the pane, and the slash menu drops its preview column when the pane cannot hold both rather than squeezing each into something unreadable.
