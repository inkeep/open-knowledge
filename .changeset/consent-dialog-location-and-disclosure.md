---
'@inkeep/open-knowledge': patch
---

The first-launch "Connect your AI tools to OpenKnowledge" dialog is easier to scan and more transparent about what it changes.

- **Per-tool location tooltip.** Each AI tool now has an info affordance that discloses exactly which config file and entry OpenKnowledge would write — for example `~/.cursor/mcp.json` → `mcpServers.open-knowledge`, or `~/.codex/config.toml` → `[mcp_servers.open-knowledge]`. This matches the disclosure Settings → AI tools already provides, so both surfaces tell you the same thing before you commit to anything.
- **Detected tools first, the rest tucked away.** The MCP connections list now shows the tools detected on your machine up front and collapses the rest behind a "Show N more tools" toggle, so the list isn't a wall of tools you don't use. If nothing is detected, every tool still shows (with its setup link) so you're never left with an empty list.
- **A pointer after Skip.** Because the dialog only appears once, choosing "Skip" now leaves a short note telling you these same choices live in Settings → AI tools & CLI, so the surface isn't lost.

No change to what gets written or when — this is about legibility of the choice, not the behavior behind it.
