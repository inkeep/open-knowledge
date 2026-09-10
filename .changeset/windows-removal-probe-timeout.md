---
'@inkeep/open-knowledge': patch
---

`ok deinit` and `ok uninstall` now allow up to 15 seconds for the Windows identity probe to start PowerShell on busy systems instead of 5 seconds; macOS and Linux keep the existing 5-second timeout.
