---
'@inkeep/open-knowledge': patch
---

Keep the slash and wiki-link suggestion picker inside the editor pane

The picker is two fixed columns — a list beside a preview — about 490px wide, so a pane narrowed by a docked terminal or agents rail could not hold it and it painted over the dock, the same escape the formatting bar and comment composer were just fixed for. The picker now caps its width to the pane, and drops the preview column when the pane cannot hold both rather than squeezing each into something unreadable.
