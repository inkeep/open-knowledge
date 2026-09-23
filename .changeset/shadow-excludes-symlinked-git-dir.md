---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
---

Keep the shadow repo from snapshotting itself when the project's `.git` is a symlink to a sibling directory (for example `.git -> .git.nosync`). A git dir or shadow dir that resolves inside the work tree under a name other than `.git` is now excluded from staging, and entries a previous build already staged are swept from the fan-out index, so the shadow repo no longer grows without bound.
