---
"@inkeep/open-knowledge": patch
---

The text-selection formatting toolbar now stays within the editor's visible content area. Previously, selecting text and then scrolling let the floating toolbar ride over the bottom status bar and the Ask AI composer (collapsed or open). It now hides when the selected text scrolls out of view — behind the top toolbar, the composer, or past the edge of the pane — and reappears when the selection scrolls back in.
