---
"@inkeep/open-knowledge": patch
---

Clicking a file in the Files or Skills sidebar reuses one tab, the way an editor preview tab works. That is still the default, but it is now a setting: turn off **Preview tabs** in Settings (or set `editor.previewTabs: false`) and every sidebar click opens in its own tab instead of replacing the current one. Pinned tabs are never reused either way, and back/forward navigation still reuses the active tab.
