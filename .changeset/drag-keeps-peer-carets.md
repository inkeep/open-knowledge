---
"@inkeep/open-knowledge": patch
---

Dragging text or a block to another place in the visual editor no longer moves collaborators' carets.

Before, a drag rewrote everything between where the text came from and where it landed, so anyone whose caret sat in between saw it jump to the start of that stretch, in both the visual and the Markdown source editor. A drag now writes only the text it removes and the text it inserts, and one undo still takes back the whole move.
