---
"@inkeep/open-knowledge": patch
---

Add [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) as an MCP-host AI option. `ok init` now detects Hermes (via `~/.hermes/`) and registers the OpenKnowledge server in `~/.hermes/config.yaml` under `mcp_servers`, using the same resilient launcher every other editor gets. Hermes keeps its whole config — models, tool filters, other MCP servers — in that one YAML file, so OK edits only its own `open-knowledge` entry via a format-preserving surgical write (the first YAML host; comments, values, key order, and block formatting are preserved) and declines rather than clobber a config it can't safely parse. Uninstall/repair strip only OK's own entry, leaving a foreign server that shares the key untouched. Like OpenClaw, Hermes is written only when it's actually installed.
