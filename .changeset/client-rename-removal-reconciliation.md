---
"@inkeep/open-knowledge": patch
---

Make client-side rename and removal reconciliation consistent across the file tree, editor tabs, and server-driven auth redirects.

Renaming a document, folder, or asset now captures the existing editor snapshot before cleanup, clears stale providers and IndexedDB rows, and only then remaps tabs and navigation. Destination persistence is cleared only when a stale pooled document actually exists, so a destination provider that was already reopened by the server redirect cannot be torn down by a second local cleanup pass. Reusing a previous document name therefore starts from clean local state without duplicating old CRDT content, while renamed tabs retain their order and active target.

Deleting content now closes the affected document, folder, and asset tabs through the same reconciliation controller before clearing deduplicated document persistence. Server-reported renames and removals use that controller too, keeping active documents, inactive tabs, URL hashes, and home redirects aligned regardless of which surface initiated the operation.
