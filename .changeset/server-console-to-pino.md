---
"@inkeep/open-knowledge": patch
---

Server-side diagnostics (file watcher, observer bridge, content filter, shadow repo, persistence, rename log, and the rest of the server package) now route through the structured pino logger instead of raw `console.*`. Warnings and errors still print in the `ok start` terminal, and every diagnostic now also lands in `.ok/local/logs/server-current.jsonl` — the file bug-report bundles collect — so watcher drop decisions, symlink-escape refusals, and bridge recovery paths are diagnosable from a bug report even when the server runs detached under the desktop app, where console output goes nowhere persistent.
