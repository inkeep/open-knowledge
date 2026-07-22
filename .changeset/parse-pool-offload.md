---
"@inkeep/open-knowledge": patch
---

Agent writes no longer block the server on large-document markdown parsing. The parse that turns a written document's markdown into editor structure now runs on a bounded worker-thread pool for documents past 8KB, so a big write (or rollback, edit, frontmatter patch) no longer freezes every other in-flight agent tool call while it parses — the event-loop stall for a concurrent 1MB write drops from roughly 2 seconds to roughly half a second, and small-write latency under load matches idle latency. Small documents keep the faster inline path, output is byte-identical either way, and any worker failure transparently falls back to the previous inline behavior.
