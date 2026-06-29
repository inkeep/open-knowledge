---
"@inkeep/open-knowledge-app": patch
---

Docked terminals now survive a renderer reload. Reloading the editor window previously collapsed the terminal dock and discarded the running shell; the dock now comes back expanded with the same live session reconnected, its running program intact, and its prior on-screen output and scrollback repainted, without re-opening it. A fresh app launch still starts with the dock hidden, and quitting or restarting the app still spawns a fresh shell.
