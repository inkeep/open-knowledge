---
"@inkeep/open-knowledge-server": patch
---

A conflict resolution that deletes the file now stays retryable when saving its state fails. The file watcher no longer misreads the server's own removal as an external delete, so it no longer clears the conflict that resolution is still working on.
