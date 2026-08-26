---
"@inkeep/open-knowledge": patch
---

File and folder names that fit in the sidebar no longer show a truncation ellipsis at fractional zoom levels like 83% or 90%. The file tree decided a name was truncated by measuring its height against a single line, and at those zoom levels the browser rounded a one-line name a fraction of a pixel past that threshold, so names with room to spare picked up an ellipsis anyway. Names that genuinely run past the edge still show theirs.
