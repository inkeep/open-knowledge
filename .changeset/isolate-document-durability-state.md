---
'@inkeep/open-knowledge': patch
---

Open Knowledge servers now keep document durability coordination inside each server instance. Running multiple servers in one process with overlapping document names no longer lets one content root's reconciled base, persistence batch, in-flight flush, agent-write marker, or store failure/divergence state affect another server. Disk reconciliation, agent writes, persistence retries, and the staleness watchdog all consume the same instance-owned state, reducing the risk of incorrect merge anchors, skipped flushes, or misleading durability telemetry when desktop, tests, or embedded hosts create more than one server.
