---
"@inkeep/open-knowledge": patch
---

Two writes to one file landing back-to-back can now share a single version-history entry, because the write path is fast enough that both fall inside the same save window. Nothing is lost: the file holds every write, and edits made seconds apart still get their own entry.
