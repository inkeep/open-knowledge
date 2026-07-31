---
"@inkeep/open-knowledge": patch
---

Switching to source mode no longer flashes the landing highlight on a block it could not verify, so a flash now always means you landed on the text you selected.

The underlying mis-landing is unchanged for now: on documents whose editor block structure and markdown source disagree about how many top-level blocks exist (for example after deleting the paragraph between two bullet lists, which leaves two adjacent lists the markdown source cannot distinguish from one), the "View in source markdown" jump and the plain mode toggle can land one or more blocks past the intended target — one block for each such divergence in the document. Those unverified landings simply no longer paint the highlight.
