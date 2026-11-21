---
'@inkeep/open-knowledge': patch
---

Local server supervisors can use `--format json-v1` with `ok status`, `ok ps`, `ok stop`, and `ok clean` to read readiness, applied runtime settings, and safe mutation outcomes without parsing terminal text. Stops preserve channel and process-identity safeguards; cleanup retains locks that changed after inspection.
