---
"@inkeep/open-knowledge": patch
---

Clicking anywhere in an Ask AI composer now focuses its input. Previously only the text itself was a focus target, so the padding around the field, the gaps beside the send button, and the empty space in the card were dead — a click there did nothing. Both composers get the standard chat-composer behavior: the bottom docked composer (open-doc and folder-overview modes) and the empty-state "Create with AI" composer. Keyboard and screen-reader users are unaffected — the input keeps its own semantics and is still reached directly via Tab and ⌘L.
