---
"@inkeep/open-knowledge": patch
---

Typing in a large document no longer costs the server twice the markdown parsing it needs. Every keystroke in the visual editor makes the server re-derive the document's source text, and that work included parsing the document's current bytes from scratch even though the previous keystroke had just produced those exact bytes and parsed them already. On a 231 KB document that redundant parse was roughly half the per-keystroke cost. The server now reuses the parse it already has when the bytes are unchanged, and falls back to parsing whenever they are not, so documents whose source is not what the serializer would emit behave exactly as before. Typing on large documents should feel more responsive; there is no change to what gets written to disk.
