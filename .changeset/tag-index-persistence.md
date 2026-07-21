---
"@inkeep/open-knowledge": patch
---

Persist the tag index with mtime reconcile for faster warm boots and branch switches. The tag index now snapshots to `.ok/local/cache/tags.json` (like the backlink cache) and re-parses only files whose mtime or size changed instead of re-reading the whole content dir on every server start and git branch switch. Backlink and tag index rebuilds also emit OpenTelemetry spans and rebuild counters/duration histograms.
