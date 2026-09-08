---
"@inkeep/open-knowledge": patch
---

Open Knowledge's tools are now auto-approved in the docked terminal when its MCP server lives in your user-global Claude Code config, not only when it lives in the project.

Two different things had been riding one switch. Trusting the project's `.mcp.json` server entry and auto-approving Open Knowledge's tools are separate decisions, and both were gated on the project entry — so anyone whose server was configured globally got neither, and had to answer a tool prompt on every launch. They are now decided independently. A foreign server that happens to be named `open-knowledge` in the project still disables auto-approval outright, even alongside a legitimate global entry, and the auto-approve preference remains the last word in every case.
