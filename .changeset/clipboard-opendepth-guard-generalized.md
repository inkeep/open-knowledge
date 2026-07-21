---
"@inkeep/open-knowledge": patch
---

Copying text from inside quotes, lists, headings, and tables no longer includes the block's markdown syntax or fabricates structure on paste. Drag-highlighting text inside a blockquote, heading, bullet or task list item, code block, or footnote definition previously copied the block's markers (`> `, `# `, `- `, `- [ ] `, code fences, `[^1]: `) along with the text, and pasting into Open Knowledge or a markdown-aware app fabricated new structure — a bullet inside a table cell, an extra nesting level from a nested list item, a heading from a heading fragment. Rich-text (`text/html`) copies of partial selections likewise no longer carry the full block element into destinations like Docs, Notion, or Gmail. Whole-structure copies are unchanged: selecting an entire list, quote, or table still copies its full markdown, and copying the complete text of a single list item still copies it as that item.
