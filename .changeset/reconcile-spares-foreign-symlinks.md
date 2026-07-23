---
"@inkeep/open-knowledge": patch
---

Stop the boot-time skill reconcile from deleting or re-pointing symlinks it does not own.

The reconcile pass that runs on every server boot treated any editor-dir skill symlink (`.claude/skills`, `.codex/skills`, `.agents/skills`, etc.) whose name had no matching `.ok/skills/<name>` source as an orphan and removed it — without checking whether the link actually resolved. Repos that check in editor-dir symlinks pointing at their own shared skill store had every such link deleted on each boot, and a valid external link whose name collided with a `.ok/skills` entry was silently re-pointed. This happened regardless of the managed-skills opt-in.

A symlink whose target resolves to a real path outside `.ok/skills` is now classified as foreign and left untouched, mirroring the ownership boundary already applied to foreign real-dir skills. Dangling links and links into `.ok/skills` remain reconcile-managed exactly as before (healed when a source exists, removed when it does not).
