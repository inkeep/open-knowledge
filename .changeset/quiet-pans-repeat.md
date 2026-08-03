---
'@inkeep/open-knowledge': patch
---

Blank lines you add at the very top or the very bottom of a document now survive. Press Enter twice or more at either end and the blank lines reach the file on disk and every other open window, instead of disappearing the next time anything else touches the document. The threshold is two: a single blank line at either end is still not preserved, because one blank line there cannot be told apart from spacing nothing typed. At the bottom that is the empty line the editor keeps below the last block so you can carry on typing, and at the top it is the blank line that separates frontmatter from the body. The threshold is the same for every document, including ones where neither of those is present.
