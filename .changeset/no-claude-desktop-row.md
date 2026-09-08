---
"@inkeep/open-knowledge": patch
---

One less row in Settings: OpenKnowledge no longer sets up Claude Desktop.

OpenKnowledge stopped integrating with Claude Desktop's Cowork tab a while ago, which left it as a single MCP config file OpenKnowledge wrote and a settings row whose only job was letting you undo that write. Neither earns its place, so setup no longer offers Claude Desktop and no longer writes to `claude_desktop_config.json`, and the row is gone.

If you want OpenKnowledge in Claude Desktop, add the MCP server to that file yourself — it is an ordinary MCP config.

An entry an earlier version wrote is left exactly as it is, so Claude Desktop keeps working as it does today. To clear it, either delete the `open-knowledge` entry from `claude_desktop_config.json` yourself, or run `ok uninstall`, which removes OpenKnowledge from every agent on the machine.
