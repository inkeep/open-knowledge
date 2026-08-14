---
"@inkeep/open-knowledge": patch
---

`server.bind` is now a per-machine setting, so a committed bind can no longer break local runs for people who clone a shared project.

Before this change, a project that committed `server.bind: 0.0.0.0` (or `::`) to `.ok/config.yml` so one machine could serve it remotely made `ok start` fail for every teammate who cloned the repo and ran it locally. The exposure interlock refused to boot because a non-loopback bind requires per-machine `server.allowExternal` consent, and consent is never committed.

`server.bind` moves from `project` scope to `project-local`, the same posture as `server.allowExternal`. A bind committed to the shared `.ok/config.yml` is now ignored, and named at startup with the fix, so local clones always bind loopback and boot. The machine that actually exposes the server sets the bind per-machine with `OK_BIND`, `ok start --bind <address>`, or `.ok/local/config.yml`.

The exposure gate is unchanged: an explicit `OK_BIND` or `--bind` to a non-loopback address without consent still refuses to start.
