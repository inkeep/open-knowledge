---
"@inkeep/open-knowledge": patch
---

Agent connections no longer makes you set things up in a particular order.

A skill row that needed an MCP server was greyed out until you ticked the MCP first, which asked you to sequence two changes OpenKnowledge already sequences for you: saving a skill whose MCP entry is missing installs both, in the right order. The rows are independent now, and the change counter tells you what a save will do.

GitHub Copilot was the row where this bit hardest. It reads OpenKnowledge from either the project file it shares with Claude Code or its own machine-wide config, and having one is enough — but the requirement was written as needing both, so a Copilot user with neither could never clear it. It now asks for either, and a save installs one rather than writing a second entry Copilot never needed.
