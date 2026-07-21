---
'@inkeep/open-knowledge': patch
---

Add a persistence staleness watchdog that bounds how long CRDT edits can sit unflushed to disk. If a document's in-memory edits ever fail to reach the on-disk markdown (for example after a transient disk error, since the store debounce only re-arms on the next edit), the server now detects the stale file within minutes and re-runs the store through the normal persistence path instead of leaving disk outdated until the next edit. The watchdog never overwrites external edits: any on-disk state the persistence layer has not reconciled makes it stand down and log instead. Three new counters (`persistenceStalenessDetected`, `persistenceStalenessForcedStores`, `persistenceStalenessStoodDown`) surface these events alongside the existing persistence queue metrics; a sustained non-zero `persistenceStalenessStoodDown` rate is the alertable one (unflushed edits pinned in memory would be lost on a restart).
