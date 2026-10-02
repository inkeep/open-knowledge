---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Symlinks can no longer expose or overwrite private `.git` or OpenKnowledge files. Docs, diagrams and attachments that link into them, or outside the project, are not opened, served, saved or duplicated, and `ok clone` and opening a shared branch in a worktree refuse such links.
