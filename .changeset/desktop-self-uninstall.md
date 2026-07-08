---
"@inkeep/open-knowledge-desktop": patch
---

Add a packaged macOS menu flow to uninstall OpenKnowledge, with a per-project picker for optionally deinitializing recent/open/running projects before removing the global footprint. After cleanup — including when cleanup reports failures, in which case the error dialog embeds the cleanup log inline — a final dialog walks the user through the one remaining manual step, then reveals OpenKnowledge.app in Finder so it can be dragged to the Trash and quits.
