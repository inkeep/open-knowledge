---
"@inkeep/open-knowledge": minor
---

`ok start` and `ok clean` now treat a server lock as stale once another program reuses its process ID, and `ok stop` and the desktop app no longer signal that program. `ok stop` exits `1` if it cannot confirm the process; stop 0.25.0-or-earlier servers yourself, then restart them.
