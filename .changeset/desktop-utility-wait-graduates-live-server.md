---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

In unpackaged Electron runs, a project server that is still starting when the 20 s startup deadline passes now gets up to 160 s instead of the project failing to open, and a server that times out is stopped rather than left running.
