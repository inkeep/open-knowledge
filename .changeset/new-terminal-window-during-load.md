---
"@inkeep/open-knowledge": patch
---

Terminal → New Terminal Window now inherits the project even when the window it was invoked from is still loading. The menu bar is live from the moment a window opens, but the app only recorded which project a window belonged to once that window's editor had finished loading. Invoking the command inside that gap resolved no project at all, so the new terminal opened silently in your home directory with no connection to the project you were looking at. The same gap also affected single-file windows and windows attached to an already-running server. A window is now associated with its project from the moment it is created, so the command resolves the same project throughout.
