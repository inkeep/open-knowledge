---
"@inkeep/open-knowledge": patch
---

Built-in skills installed for Copilot, Pi, Antigravity or LM Studio are visible again.

A user-global skill lives under that agent's own folder, and four of them sit somewhere other than where the project-scoped copy would go: `~/.copilot/skills`, `~/.pi/agent/skills`, `~/.gemini/skills` and `~/.lmstudio/skills`. OpenKnowledge seeded built-ins into all four but then looked for them in the project locations, so a built-in installed for one of those agents had no source shown and no update offer, its `SKILL.md` would not open, and deleting the skill left the copy behind.

Scope now picks the folder map, so those four are read, listed and cleaned up like every other agent's.
