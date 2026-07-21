---
'@inkeep/open-knowledge': patch
---

Pasting headings, paragraphs, or code blocks inside a list no longer swallows them into the list item. Mixed payloads now split the list at the caret: non-list blocks land as siblings of the list, and any leading/trailing pasted lists continue the list as item siblings. This also removes the stray blank lines (loose-list synthesis) and the degenerate double list marker some of these pastes produced.
