---
"@inkeep/open-knowledge": minor
---

First-class support for Google Antigravity — the agentic IDE and the `agy` terminal agent (the Gemini CLI's successor). `ok init` now registers the OpenKnowledge MCP server for Antigravity, writing the standard `mcpServers` entry (the same resilient launcher every other editor gets) into Antigravity's single user-global config at `~/.gemini/config/mcp_config.json`, shared by the IDE and `agy` alike. Antigravity has no project-scoped MCP config, so — like Claude Desktop and OpenClaw — it registers once at user scope, gated on the `~/.gemini/` home existing so a config is never written for a tool that isn't installed. It also appears in the macOS desktop app's consent dialog and is healed by the startup repair/reclaim sweeps.

Antigravity also joins the docked-terminal launch registry: the OpenKnowledge desktop app's "Open in Antigravity" action launches `agy '<prompt>'` in the docked terminal, scoped to the current doc, folder, or project. The row appears only when `agy` is detected on your `PATH`. A new integrations docs page covers MCP setup and the `agy` CLI.
