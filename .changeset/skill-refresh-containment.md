---
"@inkeep/open-knowledge": patch
---

Skill creation, import, refresh and rename now refuse out-of-scope or private-state destinations and linked `SKILL.md` files. Supporting-file changes reject links on the affected path, while refresh checks every file it would write or remove; in-scope linked skill roots remain supported.
