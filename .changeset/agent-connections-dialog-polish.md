---
"@inkeep/open-knowledge": patch
---

Settings → AI tools now tells you what each option writes, and stops claiming things that weren't true.

The per-agent setup dialog described checked boxes as "installed now — uncheck to remove". On an agent with nothing set up yet the dialog pre-selects a recommended set, so those boxes were proposals, not installed state. That sentence is gone. Every option's info tooltip now names where it writes (`.codex/config.toml`, `.codex/skills/open-knowledge/`, `~/.codex/skills/`), resolved from the satisfier's own path id — so an entry that lives in another tool's file names that file, which is why Copilot's project MCP server reads `.mcp.json`. The user-scope skill row names its root directory rather than the installed folder, because that folder's name is a CLI-side constant with no browser-reachable export. The user-global MCP row has no path at all yet; it resolves through a CLI-side map with no browser equivalent.

A blocked option now names the control that unblocks it ("Turn on Global MCP server first.") instead of "Select the required connection first." Option descriptions were rewritten for accuracy: the global MCP server says it covers every project on this machine, the project skill no longer promises a live preview, and the discovery skill reuses the wording already shipped in the first-launch dialog. Checkboxes align with their labels, scope headings match the sizing used elsewhere, and the setup-doc link is muted with an external-link arrow.
