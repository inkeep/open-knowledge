---
"@inkeep/open-knowledge": patch
---

Add LM Studio as a supported AI tool. `ok init` and the desktop consent dialog now register the OpenKnowledge MCP server into LM Studio's `mcp.json`, so a locally-hosted model in LM Studio's chat can read, search, and write your knowledge base through OK's tools — fully local inference, nothing leaves your machine.

LM Studio is an MCP host that follows Cursor's `mcp.json` notation, so the entry is the same resilient stdio launcher every other editor gets. It's user-global only (no project-scoped config, like Claude Desktop). OpenKnowledge probes both the documented `~/.lmstudio/mcp.json` and the location LM Studio actually uses on macOS (`~/.cache/lm-studio/mcp.json`, per lmstudio-ai/lmstudio-bug-tracker#1371) and writes wherever LM Studio already keeps its config.
