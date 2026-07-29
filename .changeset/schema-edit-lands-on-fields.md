---
"@inkeep/open-knowledge": patch
---

Clicking Edit next to a frontmatter schema in Settings now reliably opens the Fields editor. Previously it could drop you on the read-only Source view instead, which was especially confusing when the schema was already the file open behind the Settings dialog, and the ignored request could then send you to Fields the next time you opened that file when you had asked for Source. Edit now takes effect whether or not the schema is already open.
