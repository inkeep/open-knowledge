---
"@inkeep/open-knowledge-core": patch
---

Pasted HTML tables with block content in a cell (a list, multiple paragraphs, a code block) no longer corrupt the document. The paste conversion now normalizes cells the same way the editor's own serializer does: block structure degrades to `<br />`-joined single-line rows, so the stored markdown stays a valid GFM table instead of fracturing on the next parse. Plain `<br>` line breaks inside pasted cells are preserved as hard breaks instead of collapsing to spaces.
