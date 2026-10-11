---
"@inkeep/open-knowledge": patch
---

On macOS and Linux, stopping, restarting or updating OpenKnowledge while it installs a catalog-managed agent no longer leaves a broken npm cache entry. Custom agent commands are not covered, and a supervisor that stops everything OpenKnowledge started, such as systemd or Docker, still stops the install.
