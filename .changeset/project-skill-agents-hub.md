---
"@inkeep/open-knowledge": patch
---

LM Studio now gets OpenKnowledge's project skill.

LM Studio reads a project's skills from `<project>/.agents/skills`, the shared folder several tools read, rather than from a folder of its own. OpenKnowledge only ever wrote its project skill into per-editor folders, so picking LM Studio during setup connected it but never gave it the guidance that tells an agent how to use OpenKnowledge in your project.

Setup now writes the project skill into `.agents/skills` when you pick a tool that reads it. It is written once for the project, and only when you picked such a tool — nothing appears there otherwise.
