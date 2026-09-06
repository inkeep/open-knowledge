---
"@inkeep/open-knowledge": patch
---

Typing in a large document now costs the server less per keystroke.

On a 231 KB document the per-keystroke cost drops by roughly 1.7x to 2x, measured across
several cursor positions. The gain is position-dependent: an edit near the end of a document
gains more than one at the very top. Editing inside a list, a blockquote, or a list item keeps
part of the old cost. Nothing changes about what gets written to your files.
