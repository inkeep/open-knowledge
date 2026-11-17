---
'@inkeep/open-knowledge': patch
---

`open-knowledge mcp` now writes its log lines to stderr, so a warning such as a failed `exec` no longer breaks the JSON-RPC stream that MCP clients read on stdout.
