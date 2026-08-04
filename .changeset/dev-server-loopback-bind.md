---
"@inkeep/open-knowledge": patch
---

Agents can now reach a project opened from a development build of the desktop app. The dev launch path bound its server to `localhost`, which macOS resolves IPv6-first — so the server listened on `[::1]` while the MCP server, the agent keepalive, and `ok ps` all dial numeric IPv4 loopback. Nothing was listening at the address they called, so tool calls against that project failed and the agent's connection retried forever, even though the editor window itself worked normally. Development launches now bind the same numeric IPv4 loopback address that `ok start` already uses, so a signed release and any number of local development builds can run side by side with each project reachable by its own agent.
