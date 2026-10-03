---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Sync, `ok pull` and share-link branch switches now refuse a change that leaves a symlink pointing outside the repository, into private `.git` or OpenKnowledge state, at secrets such as `.env`, or anywhere uncheckable. Merges that change links need Git 2.38 or newer.
