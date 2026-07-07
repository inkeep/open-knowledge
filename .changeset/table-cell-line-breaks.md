---
"@inkeep/open-knowledge": patch
---

Fix tables corrupting for collaborators when a cell holds multi-line content.

Pressing Enter, Shift+Enter, or adding a list inside a table cell used to serialize raw newlines into the markdown row — the table stayed intact in your own editor but split into a truncated table plus stray bullet lines for everyone else re-opening the file (teammates, restarts, fresh checkouts), and adjacent lines could glue together with their boundary lost. Multi-line cell content now serializes to single-line GFM rows joined by `<br />`, the standard idiom GitHub renders as a line break: extra paragraphs become line breaks, list items keep a `- ` (or `1. `) marker on their own visual line, and nothing in the row ever emits a raw newline. The same guard covers Shift+Enter inside headings.

In the other direction, `<br>`, `<br/>`, and `<br />` in markdown now parse as real line breaks in the editor instead of showing as literal angle-bracket text, and each spelling is preserved byte-for-byte on save. Backslash-escaped `\<br />` and `<br>` inside inline code stay literal, as authored. A structurally empty table (no cells) now serializes to nothing instead of junk `||` bytes that reparsed as a text paragraph, and a childless component inside a cell now fires the structured drop event instead of vanishing silently.
