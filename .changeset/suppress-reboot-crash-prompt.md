---
"@inkeep/open-knowledge": patch
---

The desktop app no longer invites you to file a bug report after your machine reboots (kernel panic, forced restart, or power loss) while OpenKnowledge was running. It now recognizes when the previous session ended because the machine went down — not because the app crashed — and skips the prompt in that case, logging the event instead. Genuine app crashes still prompt exactly as before, and a crash that produced a crash dump still prompts, even across a reboot.
