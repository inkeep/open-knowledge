---
'@inkeep/open-knowledge': patch
---

Bound the telemetry sink's append backlog so a span storm can't balloon memory

`RotatingAppender` serialized writes through an unbounded promise chain. Under `SimpleSpanProcessor`, seeding a large workspace ends one span per file — tens of thousands of spans enqueue faster than serial disk appends can drain them, and each queued link pinned its payload plus chain closures until every predecessor settled. On ~34k-file projects this grew the heap by multiple GB during startup ("memory growth after parsing finished").

Queued appends are now capped at 1000 per sink path; beyond the cap, appends are rejected instead of queued (mirroring the SDK's own `maxQueueSize` drop policy). These sinks are local diagnostics, so losing records under sustained overload beats unbounded memory growth.
