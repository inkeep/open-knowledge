---
"@inkeep/open-knowledge": patch
---

Add WebSocket-lifecycle and MCP-tool observability to the server (all opt-in via OpenTelemetry, zero overhead when disabled):

- New observable gauges: `ok.ws.connections.active` (live collab connections, labeled `kind ∈ {websocket, direct}`), `ok.sessions.active`, and `ok.sessions.limit` — a session-cap stall now shows up as active pinned at the limit instead of undiagnosable 503s.
- The `traceparent` the browser already appends to the collab WebSocket URL is now extracted server-side, so the `sync.handshake` span parents to the user's browser trace instead of starting a disconnected root.
- Every MCP tool invocation now gets a `mcp.tool.<name>` span plus an `ok.mcp.tool.duration` histogram and `ok.mcp.tool.errors` counter (bounded tool-name labels), instrumented once at the dispatch spine — including the HTTP MCP endpoint, which previously had no per-tool instrumentation at all.
