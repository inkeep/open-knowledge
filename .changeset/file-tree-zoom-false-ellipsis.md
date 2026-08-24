---
"@inkeep/open-knowledge": patch
---

File and folder names in the sidebar no longer get a spurious `…` painted over their last characters when the interface is zoomed out (`View → Zoom Out`, or `Cmd/Ctrl+-` in the browser). At zoom factors below ~92% a sub-pixel rounding quirk made the tree's overflow detector treat every row as truncated, so names like `getting-started` rendered as `getting-starte…` even with plenty of free space next to them. Names that genuinely don't fit still show their ellipsis as before.
