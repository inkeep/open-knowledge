---
"@inkeep/open-knowledge": patch
---

Ephemeral single-file sessions (`ok <file>`, or opening a loose file in the desktop app) are now resilient when their server stops.

- **Single-file servers no longer idle-die under an open editor.** A single-file window now holds its server alive for as long as the window is open, the same way a project window already did. Previously the single-file server inherited the 30-minute idle-shutdown default with nothing holding it up, so it could shut down while you were still editing.

- **"Restart server" now works for a single file.** The restart action is routed to the correct server by the window that requested it, so restarting a stopped single-file session actually respawns it (before, it failed with "Couldn't restart the server"). Reopening a file whose server has stopped, or restarting it, converges to a single live window instead of leaving a dead one lingering.

- **The connection notice is honest, and the editor stops retrying a dead server.** After a short grace with no reconnection the "keep this tab open, your edits will sync when reconnected" notice changes to a clear "the server stopped — restart it to reconnect," and the renderer stops re-authenticating against an unreachable server instead of looping until the tab is closed. A genuine transient blip still reconnects within the grace and shows "Reconnected." If the connection comes back but editing still doesn't resume, the notice says so ("Connected, but your edits aren't reaching the server yet") and keeps the Restart button, instead of leaving a stale claim on screen. Navigating during an outage — to another document, an image, a folder view — no longer silences the notice, and no longer restarts the grace behind it, so hopping between tabs can't win back the "will sync when reconnected" message from a server that has actually stopped. The notice updates the next time a document is in focus.

**Behavior change for self-hosted deployments:** a loopback-bound server that declares itself externally reachable (`server.allowExternal` + `server.externalUrl` — the tunnel-to-loopback remote recipe) now defaults `server.idleShutdown` to `off` instead of `30m`. The idle timer only counts editor WebSocket connections and cannot see remote MCP agents, so such a server previously tore down under a remote agent mid-session unless you set `idleShutdown: off` by hand. A plain loopback server with no external URL is unchanged (`30m`).
