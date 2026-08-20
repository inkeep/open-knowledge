---
"@inkeep/open-knowledge": minor
---

Removed the deprecated remote-access CLI flags, config keys, and environment variable that were superseded by the ratified `server.*` surface. These were kept as thin back-compat aliases through their deprecation window; that window has closed.

**Breaking changes:**

- **`ok start --remote [url]`** is removed. Use `--external-url <url>` with exposure consent instead: `OK_ALLOW_EXTERNAL=1 OK_IDLE_SHUTDOWN=off ok start --external-url https://<your-tunnel-host>` (add `--bind` to serve a non-loopback address). The server reaches the same exposure posture through the `server.*` keys. Note: `--remote` also pinned a fixed port (24550) so the tunnel's port mapping survived restarts; the successor does not, so pass `--port 24550` (or set `server.port`) if you need a stable port.
- **`ok start --public-url <url>`** is removed. Use `--external-url <url>` (same value and semantics).
- **`ok start -H, --host <host>`** is removed. Use `--bind <address>`. The platform `HOST` environment variable is still honored.
- **`ok start --open`** is removed. Interactive loopback starts open the editor by default; suppress with `--no-open-browser`. Note: `--open`'s one distinctive capability — force-opening the browser from a **non-TTY** context (CI, spawned, containerized) — has no successor; the browser now opens only when stdout is a TTY.
- **`remote.url`** config key is removed. Use `server.externalUrl`.
- **`remote.port`** config key is removed. Use `server.port`.
- **`server.publicUrl`** config key is removed. Use `server.externalUrl` (its current name).
- **`OK_PUBLIC_URL`** environment variable is removed. Use `OK_EXTERNAL_URL`.

A stale `remote.url`, `remote.port`, or `server.publicUrl` key left in a config file now surfaces a loud `REMOVED_KEY` error naming its replacement (run `ok config migrate` to strip it) rather than being silently discarded.
