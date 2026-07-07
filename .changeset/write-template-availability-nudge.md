---
"@inkeep/open-knowledge": patch
---

Nudge agents toward folder templates on write. When a document is created in a
folder that ships templates but the write passed no `template`, the `write`
tool now lists the folder's available templates in its result and suggests
passing one next time. The write still lands unchanged — the hint is advisory,
so folders that pre-selected a shape stop getting free-form docs just because
the agent wrote from memory without listing the folder first.
