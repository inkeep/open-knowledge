---
"@inkeep/open-knowledge-desktop": patch
"@inkeep/open-knowledge-app": patch
---

Align the macOS File menu with the in-app project switcher. The File menu's project actions now sit together directly under "New from template…" and read in the same order as the bottom-left switcher: Recent project, New project, Switch project, Open folder. "Create new project…" is renamed "New project…" and the recents submenu is renamed "Recent project" to match the switcher's labels. The switcher's own action order is updated to the same sequence (New project, Switch project, Open folder) so both surfaces are consistent. Wiring, accelerators, and behavior are unchanged.
