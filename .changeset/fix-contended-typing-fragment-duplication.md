---
"@inkeep/open-knowledge": patch
---

Fixed a rare corruption where typing into a document with unregistered JSX components (like `<Steps>`/`<Step>`) in source mode could duplicate or re-indent a block in the saved document. Under CPU load, a background editor could issue a structural rewrite of the same block the server was rebuilding keystroke-by-keystroke, and both copies survived into the authoritative document. The editor no longer issues those background rewrites while it is hidden in source mode, and the server now detects and discards a duplicated block instead of persisting it, so the typed content stays intact.
