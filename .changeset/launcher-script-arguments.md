---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge-server': patch
---

On Windows, arguments Open Knowledge passes to a launcher script, such as an agent's or Cursor's, now arrive as written. A launch whose argument cannot be passed safely stops with an error that says so.
