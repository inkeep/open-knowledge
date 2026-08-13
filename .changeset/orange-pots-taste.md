---
"@inkeep/open-knowledge": patch
---

OpenKnowledge no longer creates agent integration folders for tools you do not have. Project setup, launch-time skill maintenance, store migration, import, starter-pack seeding and repair now write only into agent folders that already exist, and skip cleanly when none do. Creating a project pre-selects the agents detected on your machine rather than every agent OpenKnowledge knows about, and `.agents` is treated like any other agent folder instead of always being written. Explicit choices are still honored, including installing into `.agents` when you select it.
