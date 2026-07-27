---
"@inkeep/open-knowledge": patch
---

Copy readable LaTeX source for block math authored as `$$…$$` or ```math.

Copying block math from the WYSIWYG editor now writes readable LaTeX source (`$$\nformula\n$$`) to the `text/html` clipboard flavor for math authored as `$$…$$` or a ```math fence, matching slash-menu-authored math. Previously only slash-menu math got the source fallback while dollar- and fence-authored math (the dominant on-disk forms) pasted a non-portable KaTeX style clone into rich destinations like Gmail, Google Docs, and Notion. Block math that was previously dropped from the clipboard entirely in some editor states is now included as the same readable source too.
