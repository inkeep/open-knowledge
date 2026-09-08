---
"@inkeep/open-knowledge": patch
---

The remove confirmation now names the config file it is about to edit.

Removing OpenKnowledge from an agent showed a line reading "Global MCP server" and nothing else, so there was no way to tell which file was about to change. It now shows the path, for example `~/.lmstudio/mcp.json`.

The path was missing because the window cannot work it out on its own: these locations depend on environment variables and per-agent fallbacks that only the OpenKnowledge process resolves. It is now reported by the part that looks the file up, so the confirmation names the real file rather than a guess.
