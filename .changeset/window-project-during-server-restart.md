---
"@inkeep/open-knowledge": patch
---

Restarting a project's server no longer leaves the window it was started from without a project. While the old server was terminated and a replacement window came up, the window still on screen belonged to no project as far as the app was concerned, so anything needing one came up empty for those few seconds: New Terminal Window opened without the project, popping a note out was refused, opening another terminal tab in that window was refused, and the window's session state stopped being saved. Those actions now resolve the project for the whole restart.
