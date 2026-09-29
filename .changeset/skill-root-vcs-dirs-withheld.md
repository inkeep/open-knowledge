---
"@inkeep/open-knowledge": patch
---

Skills cloned with git no longer expose `.git` or `node_modules`, in any letter case, to the editor, API, watcher or indexers. Skill files reached through a symlink that resolves outside the skill are now refused; keep shared files inside each skill instead.
