---
"@inkeep/open-knowledge": patch
---

Opening a standalone Markdown file or a share link while OpenKnowledge is fully closed no longer reopens your previous session's project windows alongside it. The cold launch now opens only the window the link resolves to, and does not start the servers for unrelated projects.

Those previous windows are not held back for a later launch either. The saved session is cleared on the launch that suppresses it, so your next ordinary launch opens your most recent project and the rest stay reachable from File → Recent project (loose files from File → Recent files). Launching from the Dock or the app icon still restores your full window set exactly as before.
