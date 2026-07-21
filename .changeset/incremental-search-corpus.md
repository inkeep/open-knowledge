---
"@inkeep/open-knowledge": patch
---

Workspace search now maintains its full-text index incrementally. Previously any file change invalidated the whole search corpus and the next search rebuilt the entire index from scratch on the server's event loop — on a large workspace, a write burst with interleaved searches meant repeated full re-indexing. The server now diffs the document set against the live index and applies per-document insert/update/remove, so one write re-indexes one document. A from-scratch rebuild remains as the cold-start path and as an automatic fallback whenever the incremental patch cannot be proven consistent.
