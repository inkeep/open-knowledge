---
"@inkeep/open-knowledge": patch
---

Fix Git auto-sync when server-spawned Git needs the user's home directory, SSH agent, or credential-helper environment to reach a remote. This most visibly affected Windows repositories using SSH remotes, where `ok sync` and editor sync could fail with "Could not read from remote repository" while the same `git fetch` or `git push` worked in a terminal.
