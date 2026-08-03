---
"@inkeep/open-knowledge": patch
---

A bug report filed after a crash now names the version that actually crashed. The report is composed by the session that notices the crash on the next launch, and if an automatic update landed in between, that is a different build from the one that died. Reports were being attributed to the new build, which in some cases had only been running for a fraction of a second before it was asked to explain a crash it never saw. The crashed version is now read from the crash dump's own metadata, or from the marker the previous session left behind, and it appears in the report alongside the version you are running now. Seeing the two together is the point: when they differ, an update happened between the crash and the report, and the crash belongs to the older build. When a report cannot establish which version crashed, it says nothing rather than guessing, so a stated version can always be trusted.
