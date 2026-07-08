---
"@inkeep/open-knowledge-desktop": patch
---

Desktop: restore View → Reload and Force Reload on the stable channel. These page-level recovery affordances (⌘R / ⇧⌘R) were previously hidden on stable because they shared a menu cluster with Toggle Developer Tools, which stable deliberately hides. Reload and Force Reload now ship on every channel, matching other Electron apps; Toggle Developer Tools remains gated to dev and beta builds so stable still doesn't expose the raw web inspector.
