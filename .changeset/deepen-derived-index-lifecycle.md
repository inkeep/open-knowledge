---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
---

Keep backlinks, graph data, and tags consistent across every document lifecycle path. Direct creates and duplicates, disk reconciliation, deletes, folder renames, project-skill moves, ignore-file changes, startup, and branch switches now pass through one ordered derived-index coordinator with shared admission, readiness, persistence, and invalidation rules.

Derived-view queries wait for startup and branch replacement to settle instead of observing a partially rebuilt index. Rapid consecutive branch switches are serialized so one transition cannot release another transition's barrier.

Durable creates, duplicates, renames, deletes, and persistence stores now return according to authoritative disk state. Derived projection and cache persistence remain best-effort, so coordinator shutdown or a delayed cache save cannot turn an already successful write into a failure.
