---
"@inkeep/open-knowledge": patch
---

Typing in source mode no longer re-indents, duplicates, or truncates a `<Steps>` block you never touched. When one nested block inside a JSX container stopped parsing, the editor re-emitted that block's raw bytes indented two spaces per level while its siblings stayed flush-left, and the server then wrote that mixed spelling over your authored source. Landing while a keystroke was still in flight, the two spellings of the same block merged into each other: a `<Step>` block appeared twice, a line lost its tail, and the document stopped parsing. The raw bytes of a block the parser could not read are now emitted exactly as authored, so there is no second spelling to merge against.
