---
"@inkeep/open-knowledge": patch
---

`ok init` now installs the OpenKnowledge MCP server into the GitHub Copilot CLI. When you run `ok init` (or the desktop first-launch consent dialog) and `~/.copilot` is present, Copilot is detected alongside Claude Code, Cursor, and Codex and gets a `local` MCP entry written to `~/.copilot/mcp-config.json` (honoring `COPILOT_HOME`), with every tool pre-approved so the agent can call the OpenKnowledge `exec` tool immediately. The Copilot CLI MCP config is global only — it writes no project-local config. `ok init` also installs the project skill at `.github/skills/open-knowledge/SKILL.md` (and `ok start` keeps it refreshed), so Copilot CLI gets the same in-repo OpenKnowledge skill that Claude Code does.
