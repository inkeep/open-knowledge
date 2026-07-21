---
"@inkeep/open-knowledge": patch
---

Mermaid WYSIWYG polish. The Edit Mermaid source dialog's preview is now a full WYSIWYG canvas — click popovers, double-click label editing, and connect gestures rewrite the dialog draft live, with Save persisting and Cancel discarding as usual. Diagram popovers behave like part of the diagram: they anchor at the exact box you clicked (participants render two), flip below the node instead of clipping at the block edge, follow the diagram when it pans or zooms, and close when you interact anywhere else. Inline label editing now feels like a plain textbox — the canvas holds re-renders while you type, so the caret never jumps and Escape reliably reverts.
