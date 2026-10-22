---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
---

Server shutdown now waits, up to a time limit, for backlink and tag cache writes to finish, so removing a project folder right after stopping its server no longer races those writes.
