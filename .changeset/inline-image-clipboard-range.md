---
"@inkeep/open-knowledge": patch
---

Fixed copying prose that contains an inline image with a relative or otherwise non-portable URL. The clipboard HTML previously duplicated the paragraph's leading text inside the source-fallback span and silently dropped the image markdown; the fallback now carries the image's own markdown (`![alt](path)`), so pasting into other apps preserves the full sentence and the image reference.
