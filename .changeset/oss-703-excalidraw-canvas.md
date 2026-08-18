---
"@inkeep/open-knowledge": patch
---

Add native Excalidraw drawing-canvas support for `.excalidraw` files. Opening one in the editor now mounts an infinite canvas board; changes serialize to the file's `Y.Text('source')` as an Excalidraw JSON snapshot and sync live across peers.

Scoped to the `.excalidraw` extension only. `.canvas` was intentionally left alone — it's already Obsidian's canvas JSON schema, which the text viewer opens with syntax highlighting; Excalidraw can't parse it.
