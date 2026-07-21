---
"@inkeep/open-knowledge": patch
---

Agent write bursts across many documents no longer stall with "server busy" (503) once 256 documents have been touched. At the session cap the server now evicts the least-recently-used idle agent session — flushing its document to disk first — so large bursts stream through a bounded working set. Sessions used within the last few seconds are never evicted, and a 503 is still returned only when every session is genuinely in use. Undo history for an evicted session ends with it (same as a disconnect); a later write on that document starts a fresh session under the same agent identity, so edit attribution is unaffected. New diagnostics: an `ok.sessions.evictions_total` OpenTelemetry counter and an `agentSessionEvictions` counter on `GET /api/metrics/reconciliation`.
