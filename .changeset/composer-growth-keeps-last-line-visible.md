---
"@inkeep/open-knowledge": patch
---

The Ask AI composer no longer covers the last line of a document as it grows.

Typing a long prompt at the end of any file the editor opens in a text view (`.ts`, `.py`, `.json`, `.yaml`, `.txt` and the rest), or of a `.mmd` or `.mermaid` diagram in source mode, used to let the growing composer cover the line the caret was on. The composer reserved room at the bottom of those editors but the scroll position did not follow it, so the last line slid underneath. It now stays above the composer.
