---
"@inkeep/open-knowledge": minor
---

Built-in terminal now auto-approves OpenKnowledge's own tools for agents it launches, so the read/write loop runs without a per-call approval wall. Claude gets an allow-list (OK's MCP tools + the `ok open` command) with a deny-list that keeps `delete`/`move`/`share_link`/`install` prompting; Codex gets its per-server `approve` mode. Other shell commands, non-OK file edits, and other MCP servers stay gated as before. Applied per launch (nothing written to your CLI config files). Toggle in Settings → Terminal ("Let agents use OpenKnowledge without asking", `agents.autoApproveOkTools`), on by default, per machine. When Codex is installed but OpenKnowledge isn't configured for it, the toggle says so instead of letting Codex quietly keep asking.
