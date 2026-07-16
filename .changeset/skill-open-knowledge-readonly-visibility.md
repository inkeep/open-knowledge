---
"@inkeep/open-knowledge": minor
---

Surface OpenKnowledge's built-in `open-knowledge` project skill in the Skills UI
as a read-only, "Managed by OpenKnowledge" entry. It was previously hidden, so
you could not see what your agents actually load. You can now open and read its
SKILL.md (and references) from the Skills sidebar and Settings; edit, rename,
delete, and install are disabled in the UI, and the skill write/rename/delete
APIs refuse mutations to the reserved built-in skills (defense in depth).
