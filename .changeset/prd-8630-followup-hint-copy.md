---
"@inkeep/open-knowledge": patch
---

Settings → AI tools no longer makes a connected agent look like something is still wrong.

A connected project MCP entry carried an amber follow-up line, announced as a live status update, directly under the checkmark and "Installed". It read like a security step OpenKnowledge was waiting on, and it never went away, because OpenKnowledge cannot tell whether the agent has accepted the entry. Claude Code asks for approval on its own the first time you run it in a project. Codex and GitHub Copilot load a project entry once the folder is trusted, which the CLI asks about on first run in a new folder; their setup dialogs now say so, and Codex's names the remedy. Those rows now show no follow-up line at all.

Cursor keeps one, for the case where you really do have to act: a project-only registration. Cursor lists a new `.cursor/mcp.json` server as disabled until you switch it on under Customize → MCPs, and OpenKnowledge cannot see that setting, so when the project entry is the only thing connecting Cursor the row says exactly that and names where to go. A user-level registration, which `ok init` writes by default, starts on its own and its row shows no line. It now reads as ordinary muted text instead of an amber status.
