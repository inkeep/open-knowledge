---
"@inkeep/open-knowledge": patch
---

Opening a share link with the app fully closed now reliably lands on the shared target. Previously, if macOS delivered the link a beat after launch, the app restored your last-open project first and the clone dialog for a repo you don't have locally was immediately buried behind that restored window.

The desktop boot path now waits for cold-start link delivery to settle (a short grace window that ends early the moment a link claims the launch) before deciding whether to restore the previous project. A launch without any link still restores your last project as before; the wait overlaps startup work, so it adds no noticeable delay.
