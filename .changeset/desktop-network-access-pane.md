---
"@inkeep/open-knowledge": minor
---

Desktop: a new **Settings → This project → Network access** pane lets you expose a project's server over a tunnel you run (for example Tailscale, a reverse proxy, or a VPN), so a collaborator on the tunnel can open the editor and connect an agent to `/mcp` while you keep editing locally. Enter the public origin your tunnel serves, pick a fixed local port, and click **Apply and restart project server**. The pane is tunnel-agnostic — it never provisions or introspects a tunnel.

Exposure consent is stored per-machine in `.ok/local/config.yml` (gitignored), so it never travels via clone or share; the tunnel URL and port live in the project config. A fresh clone of the same repo opens loopback-only, and a project that would bind beyond this machine still refuses to start without consent. The tunnel stays yours — OpenKnowledge provisions nothing and runs no server-side authentication, so restrict access at the tunnel's edge (a Tailscale ACL, a reverse proxy with auth, or a firewall).

The desktop server now also honors a configured `server.port` (pinning it keeps a tunnel's target stable across restarts, falling back to an automatic port if the fixed one is taken) and reads per-machine and user-global config layers, not just the committed project config.
