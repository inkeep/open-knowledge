---
'@inkeep/open-knowledge': patch
---

Fixed a crash that could take down the whole app window, replacing it with the error screen. It hit when the set of open side panels changed — switching between files, clicking a folder, closing the right chat panel, or collapsing the right side panes — and was most likely with the document panel collapsed and a right-hand column open. The layout engine ended up validating a saved multi-panel split against fewer panels than were on screen and threw `Invalid 2 panel layout: ...`.

The underlying resizable-panels library is now patched to recover from that momentary mismatch — it re-derives a valid split for the panels that are actually present instead of throwing — so opening, closing, and switching panels no longer risks crashing the shell. In the rare case the mismatch occurs, the affected panel widths reset to an even split rather than being preserved.
