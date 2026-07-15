---
'@inkeep/open-knowledge': patch
---

Literal non-breaking spaces (U+00A0) in document prose now survive WYSIWYG edits and every markdown re-parse, instead of silently becoming regular spaces. The pipeline's internal NBSP whitespace sentinel was removed; whitespace-only text nodes are preserved by the existing inline-whitespace char-ref mechanism, which now also covers NBSP at emphasis boundaries.
