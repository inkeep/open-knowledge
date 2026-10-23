---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
---

Let large MCP audit and project-wide lint scans run beyond 30 seconds. Client timeouts still apply, with a 120-second limit for `ok mcp --port` and Node's 300-second response-header deadline; narrow the scan path when needed.
