---
"@inkeep/open-knowledge": patch
---

Version history that a consolidation had folded away could be destroyed by routine checkpoint cleanup. Consolidation picked the single newest checkpoint to chain onto, without regard to what kind it was. The silent rescue checkpoints written when the editor bridge detects content loss are parentless, so whenever one of them happened to be newest, the new consolidation chained onto a dead end and the previous consolidation was left dangling. The next cleanup pass then deleted that dangling checkpoint's ref, and with nothing else pointing at it, its full content snapshot and every edit it had folded in became unreachable and were lost at the next git garbage collection. A same-second pair of consolidations could fork the chain the same way with no rescue checkpoint involved at all.

Consolidation now adopts every dangling anchor rather than the single newest one, and only checkpoints whose retention cannot be emptied are eligible to anchor. Cleanup is non-destructive again. Two side effects of the old behavior are also fixed: a rescue checkpoint is no longer kept alive forever by being chained onto, so the retention budget that expires it now genuinely does, and the per-document activity history no longer goes silently empty after a rescue checkpoint lands following a consolidation.
