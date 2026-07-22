---
"@inkeep/open-knowledge-desktop": patch
---

Git sync now works when SSH keys live in an external SSH agent (1Password, Proton Pass, a custom `ssh-agent`). Finder-launched apps inherit macOS's default agent socket instead of the one your shell exports, so pushes over SSH failed with "Permission denied (publickey)" while terminal git worked. At startup the desktop app now reads `SSH_AUTH_SOCK` from your login shell and passes it to every git operation.
