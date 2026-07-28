---
'@inkeep/open-knowledge': patch
---

Fix bold, italic, and other formatting being dropped from wiki links, images, inline math, tags,
and line breaks.

Formatting applied to an inline element was lost as soon as the document round-tripped through the
collaboration layer. Writing `**[[Page]]**` in source mode, in the editor, or through the agent API
produced `[[Page]]` on disk, and the emphasis could not be re-applied because it was discarded
again on the next sync. A soft line break inside bold text split it into two separate bold runs.

| Before | After |
| --- | --- |
| `**[[Page]]**` → `[[Page]]` | `**[[Page]]**` → `**[[Page]]**` |
| `*![alt](img.png)*` → `![alt](img.png)` | `*![alt](img.png)*` → `*![alt](img.png)*` |
| `**a<br>b**` → `**a**<br>**b**` | `**a<br>b**` → `**a<br>b**` |

This affects `[[wiki links]]`, images, image references, footnote references, inline math, tags,
inline JSX, and hard line breaks.

Documents already saved without their formatting are not repaired automatically — the formatting
has to be applied again. If you run multiple clients against one server, update them together:
an older client editing a document alongside an updated one will strip the restored formatting.
