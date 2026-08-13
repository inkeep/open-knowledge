---
"@inkeep/open-knowledge": patch
---

Opening a plain terminal no longer shows the "Claude Code (claude) isn't installed" banner. The docked terminal probed Claude readiness on every session, so a bare tab opened with Cmd+J, the Terminal menu's "New Terminal", or the dock's ＋ nagged about claude (or about connecting OpenKnowledge tools) even though the user never picked a CLI. Readiness feedback is now scoped to launches that actually target the Claude CLI: those still surface the install and connect-tools banners, while plain tabs, "run this command" tabs, and reload-adopted tabs stay banner-free.
