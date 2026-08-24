---
'@inkeep/open-knowledge': patch
---

Keep the formatting bar and comment composer inside the editor pane when a session dock narrows it

Docking the terminal or the agents rail beside a dragged-in editor column left the pane narrower than the formatting bar, and the bar painted its tail controls on top of the dock. Boundary-aware positioning could not fix it on its own: a clamp relocates a surface but cannot shrink one, so a fixed-width bar overhangs a narrower pane from every coordinate. Selection-anchored surfaces now cap their width to the pane, and the bar wraps to a second row rather than overflowing.
