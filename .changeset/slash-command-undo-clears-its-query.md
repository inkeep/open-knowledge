---
"@inkeep/open-knowledge": patch
---

Undoing a slash command no longer leaves its query behind. Taking back a heading inserted from `/he` put the literal `/he` back into the paragraph, so the undo that removed the block left text you then had to delete by hand. The query and the block it produced are now retracted together.
