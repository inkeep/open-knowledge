---
"@inkeep/open-knowledge": patch
---

Added OpenClaw and Hermes as "Open with AI" terminal launch targets in OK Desktop, alongside the existing agent CLIs. OpenClaw opens its interactive TUI seeded with the composed prompt via `openclaw chat --message '<prompt>'`. Hermes has no starting-prompt argument (its only prompt-carrying modes run once and exit), so OK launches `hermes chat` and, once Hermes signals its input is ready, delivers the prompt as a bracketed-paste write — bracketed paste keeps a multi-line prompt intact and inert to the TUI's key handling, then submits it. The paste waits for Hermes' readiness signal (with a timeout fallback) rather than a fixed delay, so it lands cleanly on slow and fast boots alike. Both were already supported as MCP servers; this adds the one-click terminal handoff.
