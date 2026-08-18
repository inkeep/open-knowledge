---
"@inkeep/open-knowledge": patch
---

Connecting an editor in Settings → AI tools no longer creates a config directory for a tool you don't have installed. For Cursor, Codex, Copilot, OpenCode and Claude Desktop, that directory is also how Open Knowledge decides the tool is installed, so switching one on used to make the app report the editor as present everywhere from then on, permanently and with no way to undo it. Those rows now say the tool wasn't found and point at their setup guide instead. Claude Code is unaffected, since its config file sits next to its detection folder rather than inside it.
