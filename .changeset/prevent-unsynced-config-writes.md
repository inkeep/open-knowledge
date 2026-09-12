---
"@inkeep/open-knowledge": patch
---

Fix a bug where clicking `Enable terminal` while project settings were loading could leave the terminal off. `Enable terminal`, sidebar view toggles, skill pinning, and `Reset view filters` refuse settings changes until the relevant settings load. The theme picker in `AI tools & CLI` still works locally when shared settings are unavailable; otherwise it waits for them to load. A rejected settings write leaves the current theme in place. Native View-menu actions remain available and report a loading notice during this window.
