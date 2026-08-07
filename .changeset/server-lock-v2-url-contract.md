---
"@inkeep/open-knowledge": patch
---

Server and UI lock files now advertise a full base URL (`url`) alongside the port, and `capabilities` accurately lists the surfaces the process actually serves, including `"ui"` when the process itself hosts the web app. Discovery consumers (the MCP stdio shim, `preview_url`, desktop attach, and the off-cwd resolver) prefer the advertised URL and fall back to the port for locks written by older versions, so mixed-version setups keep working through the upgrade. `preview_url` can now tell "no UI is mounted" apart from "the UI runs in a sibling process" instead of ever returning a dead link.
