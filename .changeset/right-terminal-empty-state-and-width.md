---
"@inkeep/open-knowledge": patch
---

Make the right-docked terminal consistent with the bottom dock on the "new tab"
(empty editor) screen: opening a terminal in either position now collapses the
empty state to its header, dropping the chat composer bubble and starter-pack
list — the open terminal is its own AI entry point, so the bubble no longer
competes with it. The header bottom-anchors above a bottom dock and centers
beside a right-docked terminal.

The right-docked terminal can also be resized much wider now: the fixed 900px
cap is gone, and the column can grow to near-full width while the editor always
keeps a minimum visible sliver — mirroring how tall the bottom dock can already
be dragged. A wide width persists across reloads instead of snapping back.
