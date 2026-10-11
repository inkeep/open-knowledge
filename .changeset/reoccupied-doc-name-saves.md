---
"@inkeep/open-knowledge": patch
---

Edits to a page re-created at a path that was renamed, moved or removed outside the app are now saved to disk, instead of being reported as saved while only kept in memory. Agent writes to a path that is still gone now fail with a `doc-removed` error.
