---
"@inkeep/open-knowledge": minor
---

The canonical external origin setting is renamed from `publicUrl` to `externalUrl` across all three configuration surfaces: the config key is now `server.externalUrl`, the environment variable `OK_EXTERNAL_URL`, and the CLI flag `ok start --external-url <url>`. "Public" wrongly implied an internet-public, unauthenticated server; the field really names the external-facing origin, which commonly sits behind Tailscale, Cloudflare Access, or other edge auth. The old spellings — `server.publicUrl`, `OK_PUBLIC_URL`, and `--public-url` — keep working as deprecated aliases with identical semantics and precedence, and each use prints a deprecation notice naming the new spelling. They will be removed in a later release.

One caution for shared (committed) configs: older app versions read only `server.publicUrl` and silently ignore `server.externalUrl`, so renaming the committed key strands collaborators who have not upgraded on a loopback-derived origin. While a team is mid-upgrade, commit both keys with the same value — new versions prefer `server.externalUrl` (no notice when both are set) and old versions keep reading `server.publicUrl`; drop the old key once everyone is current.
