---
"@inkeep/open-knowledge": patch
---

Diagnostic bundles now cover a useful window of time on projects with many linked files. The background sweep that repairs dropped file-watcher events re-checks every referenced file target every few seconds, and it was recording a telemetry span for each one even when nothing had changed. On a large project that is thousands of empty spans a minute, enough to fill the fixed-size local span buffer and recycle it while the user was still reproducing the problem, so a bug report often arrived carrying telemetry that no longer reached back to the failure being reported. Existence checks that find nothing to repair no longer record anything, so an idle project produces no index-update spans at all.
