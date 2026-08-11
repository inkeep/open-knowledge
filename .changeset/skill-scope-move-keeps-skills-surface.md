---
"@inkeep/open-knowledge": patch
---

Moving a skill between project and global no longer drops you into the file tree. When the only tab open for that skill was one of its bundle files, the move closed that tab, left the Skills sidebar with nothing to show, and fell back to Files on an unrelated document. The open tab now follows the skill to its new scope, and companion files a bundle ships outside `references/` are recognized as part of the skill, so a move or a delete no longer strands their tab on a document that is gone.
