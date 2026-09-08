---
"@inkeep/open-knowledge-app": patch
---

Sidebar folders you collapse now stay collapsed. Previously, collapsing a folder left its subfolders marked as open behind the scenes, so the next time the tree refreshed (which happens whenever any folder is expanded) those subfolders were restored and dragged their parents back open with them.
