---
"@inkeep/open-knowledge": patch
---

The sidebar's page directory no longer storms the server during bulk agent writes. File-change pushes now coalesce into a single trailing refetch (~300 ms window) instead of refiring the full page-list and document-list walk on every push, so an agent writing many files per second no longer triggers ~10 full corpus refetches and index rebuilds per second. The initial load and manual refreshes stay immediate.
