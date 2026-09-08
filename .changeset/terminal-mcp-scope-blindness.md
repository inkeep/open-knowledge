---
"@inkeep/open-knowledge": patch
---

The docked terminal no longer tells you Claude Code's Open Knowledge tools aren't connected when they are.

Claude Code reads two config scopes — your user-global `~/.claude.json` and the project's `.mcp.json` — but the terminal's readiness check only looked at the global one. A project that carries Open Knowledge's MCP entry locally, with nothing configured globally, got a persistent "tools aren't connected" strip despite the tools working. Readiness now treats either scope as sufficient, and records which one supplied it. A user with neither still gets the nudge, unchanged.
