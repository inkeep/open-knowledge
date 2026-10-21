---
'@inkeep/open-knowledge': minor
---

Agent writes, the in-app agent's file writes included, report `outcome`, `saved` and `nextStep`. Writes that answered 200 can answer 409 `both-kept` or 503 `save-held` (landed; do not retry) or 409 `write-dropped`; in-app file writes return error `-32010` unless applied or merged first. `retryWhen` and warning-level `nextStep` are deprecated.
