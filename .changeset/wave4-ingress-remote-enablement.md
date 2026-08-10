---
'@inkeep/open-knowledge': minor
---

Remote enablement: the `server.*` configuration keys now drive real behavior, and the server's ingress runs through one consolidated admission path.

- Environment variables land per the ratified mapping: `PORT`, `OK_BIND` (space-separated list), `OK_PUBLIC_URL`, `OK_ALLOW_EXTERNAL`, `OK_OPEN_BROWSER`, `OK_IDLE_SHUTDOWN`. Booleans accept `1`/`0`/`true`/`false`; a malformed value refuses to boot naming the variable. Precedence is flags > env > project-local > project > user config.
- `server.bind` is a real list: every configured address gets a listener on the same port. `server.publicUrl` feeds Host/Origin validation and issued URLs.
- The exposure consent interlock is enforced: a non-loopback bind without `server.allowExternal` refuses to boot with a one-line fix. A committed `server.publicUrl` under a loopback bind is inert metadata — it never blocks a teammate who clones a deploy repo and opens it locally; publicUrl's consent requirement surfaces at request time. Consent relaxes the loopback-peer check only — Host and Origin always validate against loopback names, the bind-address literals, and the configured public URL. Behind a reverse proxy or tunnel, forwarded headers are tolerated (never trusted) once consent and `server.publicUrl` are set.
- `.ok/local/config.yml` (the per-machine layer) now participates in CLI config loading with per-key scope ownership, so a committed `server.allowExternal: true` can never arm exposure on another machine.
- Starting an exposed server (`server.allowExternal` on a non-loopback bind or with a `publicUrl`) prints an unmissable warning: there is no server-side authentication, so anyone who can reach it has full control including sync, publishing, GitHub credentials, and local operations — restrict access at the edge (Tailscale ACL, an authenticating reverse proxy, or a firewall).
- The editor renders on plain-HTTP non-localhost origins (a tailnet or LAN IP, direct-IP access). `crypto.randomUUID()` is a secure-context-only API and was throwing at module load on those origins, leaving a blank screen; identity generation now falls back to `crypto.getRandomValues` when `randomUUID` is unavailable.
- `ok start --idle-shutdown off` no longer self-terminates on boot: an off flag now threads through to disable idle-shutdown identically to the exposed-bind derived default.
