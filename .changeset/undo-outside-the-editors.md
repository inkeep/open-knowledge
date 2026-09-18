---
"@inkeep/open-knowledge": patch
---

Undo and redo now reach the app's own history when focus sits outside both editors, after clicking the mode toggle for instance, and from the desktop Edit menu. They previously reached the browser's undo, which could skip an edit or put a deleted one back.
