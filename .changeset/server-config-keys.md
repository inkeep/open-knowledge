---
"@inkeep/open-knowledge": patch
---

New `server.*` config section in `.ok/config.yml` — the canonical way to describe how the OpenKnowledge server listens and is reached, ahead of the unified single-server boot. `server.port`, `server.bind` (a list of bind addresses, loopback-only by default), and `server.publicUrl` (the canonical external origin) are committed project settings; `server.openBrowser`, `server.idleShutdown`, and the `server.allowExternal` exposure-consent interlock are per-machine settings in the gitignored `.ok/local/config.yml`, so consent to external exposure never travels via git, clone, or share. `openBrowser` and `idleShutdown` default from the bind: a loopback-only server opens the UI and idles out after 30 minutes, while an exposed or containerized server is headless and stays up — there is deliberately no `server.mode` key.

The existing `remote.url` and `remote.port` keys are superseded: each is still read while its successor (`server.publicUrl` / `server.port`) is absent, so existing configs keep working unchanged. The `server.host` removed-key message now points at `server.bind`. Every config field also now declares whether it applies live or at the next server start, and this is documented in each field's description.
