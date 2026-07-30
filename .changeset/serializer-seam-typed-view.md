---
'@inkeep/open-knowledge': patch
---

Stop two typed editor states from losing content on the next re-derivation.

A hard break typed at the end of a block (Shift+Enter) was dropped at serialize time, so the break vanished with no trace in the bytes and none in the view. It is now re-spelled to `<br />`, the same lossless spelling the serializer already uses inside table cells and headings.

An empty task item lost its checkbox and came back as a plain list item whose text was the literal `[ ]`, at every position in the list. GFM cannot spell a task item with no content, so an empty one now serializes with a `&#x20;` the parse side takes back out, and the checkbox round-trips.
