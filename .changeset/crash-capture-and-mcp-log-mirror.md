---
"@inkeep/open-knowledge": patch
---

Bug-report bundles now capture why the server died and what the MCP server was doing. A fatal server crash (uncaught exception or unhandled rejection) writes a synchronous `last-server-crash.json` record — timestamp, error name/message/stack, pid, uptime — under `.ok/local/` plus a final fatal line in the server log, both collected into `ok bug-report` and `ok diagnose bundle` output; previously a hard crash lost the async log sink's tail and bundles could only say "server not running". The global MCP stdio server's `[mcp]` stderr diagnostics are now also mirrored to `~/.ok/logs/mcp.<date>.log` (pruned at each startup by a 7-day age window and an aggregate size cap), so bundles include the agent-ingress diagnostics that previously landed only in the MCP host's own log folder.
