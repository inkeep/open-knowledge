---
"@inkeep/open-knowledge": patch
---

The markdown bridge is gone from the server, so agent writes, disk saves and rollbacks do less work. Its four switches — `bridge.deferGuard`, `fixedPoint`, `preDrain` and `lossDetector` — are removed; `ok config migrate` strips them from an existing config. Eight bridge counters remain in the metrics payload at rest.
