---
"@inkeep/open-knowledge": minor
---

OpenKnowledge Desktop's built-in terminal now works on Windows 10 version 1809 or later, Windows 11, and Windows Server 2019 or later. The Windows terminal includes automatic Windows PowerShell, PowerShell 7, and `cmd.exe` discovery, Git Bash support through an explicit `terminal.shell` override, agent CLI and managed-command launching, clipboard shortcuts, packaged ConPTY support, and update-time cleanup for console hosts owned by the installed app. Agent-launch prompts are pasted without being submitted automatically, so review the prompt and press Enter to send it. Existing absolute overrides outside the supported shell families remain usable for plain terminal tabs, with a capability notice explaining their launch and dropped-file limits.
