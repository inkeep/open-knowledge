---
"@inkeep/open-knowledge": patch
---

Frontmatter schema problems no longer underline body text that isn't wrong, and now report next to whatever can actually fix them. When a schema required frontmatter that a document didn't have, the error had no property to attach to, so the red squiggle landed on the document's first line — usually a perfectly correct heading, with no hint that the real problem was a missing frontmatter block.

Required properties the document is missing now show as a warning count on the toolbar's properties button, since adding a property is the fix and there is no row to point at yet. Properties that are present but don't match the schema — a wrong type, a value outside an allowed set — show as a warning count beside the Properties heading, next to the existing property count rather than replacing it. Both carry the specific messages in their tooltip, and the Problems panel continues to carry the full explanation. Clicking a frontmatter row in the Problems panel no longer jumps the cursor to that unrelated first block.

The Problems tab's own count badge picks up the same warning styling, so the three read as one family. Body-anchored rules (hard tabs, heading levels, and the rest of markdownlint) are unchanged and still mark the block they're about.
