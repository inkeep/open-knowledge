---
'@inkeep/open-knowledge': patch
---

Fix the outline not following your scroll position in Markdown source mode

The outline pane now highlights the heading you are reading while you scroll the Markdown source view, the same way it already did in the rich-text view. The position marker, the highlighted row, and the row's accessibility state all keep up as you scroll, and clicking an outline row leaves that heading highlighted once the view settles.

Headings written with Windows line endings are also recognized now. Previously a document saved with CRLF line endings produced an empty outline.
