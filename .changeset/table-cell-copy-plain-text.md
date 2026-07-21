---
"@inkeep/open-knowledge": patch
---

Copying text from inside a table cell now copies just that text, not the whole Markdown table. Previously, drag-highlighting content in a table cell and copying it yielded the entire table — the `|` pipes and the `| -- |` delimiter row — because the selection's content included the enclosing table structure. A text selection confined to a single cell now serializes to only the cell's content, with its inline formatting (inline code, bold, links, etc.) preserved exactly as it would be when copying the same text from a paragraph, and the table structure dropped.
