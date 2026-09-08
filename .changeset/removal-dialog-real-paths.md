---
"@inkeep/open-knowledge": patch
---

The remove dialog lists real file paths again.

Under "this deletes the MCP server entries and skill files listed below" it was printing OpenKnowledge's internal key for each location, so a row about your project's `.mcp.json` read `editor-project-config:claude`. It now shows the path, and shows nothing at all for the rows that have no file behind them.
