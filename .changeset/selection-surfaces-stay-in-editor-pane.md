---
"@inkeep/open-knowledge": patch
---

Floating surfaces anchored inside the editor now stay inside the editor pane.

The formatting toolbar and the comment composer used to escape it. Selecting a passage taller than the visible area and then scrolling left them floating above the pane over the document tab strip, or below it over the Ask AI composer and the status footer. Both now clamp to the same visible region: below the toolbar, above the Ask AI composer and any conflict-resolution footer, and inside the pane's side edges. The toolbar still disappears once the selected passage is completely out of sight, and the comment composer stays put while it holds a draft so an in-progress comment is never lost to a scroll.

The same fix reaches two more surfaces that had the same defect. The slash, wiki-link, and tag pickers used to overhang the pane's right edge whenever the cursor sat past the middle of a line, and could extend below the pane over the Ask AI composer. They now stay inside the pane, and their list shortens to fit the room actually available beside the cursor instead of covering the line being typed on. The markdown-lint hover callout used to paint over the editor toolbar when its line sat near the top of the pane, and to overhang the right edge near the end of a line. It now stays inside the pane on both axes.
