---
"@inkeep/open-knowledge": patch
---

Standalone Mermaid files (`.mmd` / `.mermaid`) are now editable, matching the WYSIWYG editing you already get for ` ```mermaid ` code fences inside a document. Opening one of these files shows the same rendered diagram — click a flowchart node/edge label, a sequence message, or a participant to edit it in place — and the toolbar's source toggle now opens an editable source view (with Mermaid syntax highlighting) instead of a read-only one. Edits autosave to the file and sync live, since these files are now backed by the same real-time collaboration and undo as every other document.
