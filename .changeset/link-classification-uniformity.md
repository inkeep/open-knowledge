---
'@inkeep/open-knowledge': patch
---

Link classification is now uniform across the editor, the audit, and the document graph, so every surface gives the same answer about whether a target exists.

- Reference-style links resolve to their definition's destination in the editor: the link chip, hover card, and open action now work for `[text][label]` forms, and reference-style images render their resolved image.
- Link syntax inside non-rendering regions (HTML comments, raw `<pre>` and `<code>` elements) is no longer promoted to a live link, removing false dead-link warnings for authored examples.
- Wiki links and embeds resolve against the same tracked-file inventory the server classifies with, so file-shaped embeds render on their own merits and missing targets are flagged consistently in both editor modes.
- The hover card no longer offers Create page over an extension-less link whose target file already exists.
- Image failure placeholders share one design that distinguishes a missing file from an image that could not be displayed, and they stay inside table cells.
