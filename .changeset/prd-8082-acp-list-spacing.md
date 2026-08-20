---
"@inkeep/open-knowledge": patch
---

Numbered and bulleted lists in ACP agent messages render with consistent spacing between items and between blocks inside an item, and multi-paragraph items no longer collapse onto a single line — Streamdown's `[&>p]:inline` on `<li>` was folding sibling paragraphs and letting code-block margins push items apart unevenly.
