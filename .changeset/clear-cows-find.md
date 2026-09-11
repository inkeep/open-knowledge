---
"@inkeep/open-knowledge": patch
---

Open the selected terminal agent's setup dialog from Connect tools. Terminal agents now use the same MCP connection checks as Agent connections in Settings. Canceling setup keeps the warning available, and completing setup refreshes it. After installing tools from the terminal or Settings, a notice lets affected open terminal sessions in the same window restart to use them. A failed connection check keeps Retry available until it succeeds. Dismissing a warning remains specific to that notice and terminal session.
