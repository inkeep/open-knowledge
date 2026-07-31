---
"@inkeep/open-knowledge": patch
---

Stop background sync from popping a GitHub sign-in window on Windows.

On Windows, a project with a GitHub remote could open a "GitHub — Select an account" window every few minutes, unprompted, for as long as the app was running — even while syncing was healthy and pushing successfully. The window came from Git Credential Manager, the credential helper Git for Windows installs by default, not from OpenKnowledge's own sign-in flow. OpenKnowledge already told git not to prompt, but that setting only silences git's own terminal prompt and does nothing about a credential helper's graphical prompt, so every background fetch that missed the credential store put a dialog on the desktop.

OpenKnowledge's own git commands now run fully non-interactively, so a missing or expired credential can no longer surface as a surprise system dialog. Instead it appears where it belongs: the sync status shows "reconnect to resume syncing" with a Sign in button, on your schedule rather than interrupting whatever you were doing. The same applies to opening a shared branch, where a credential dialog could previously outlive the fetch that raised it and sit on your desktop with nothing behind it. macOS and Linux were unaffected in practice, since their usual credential helpers never draw a window.
