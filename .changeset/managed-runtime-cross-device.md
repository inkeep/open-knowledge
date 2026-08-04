---
"@inkeep/open-knowledge": patch
---

Managed Node.js and uv runtimes now install correctly when the temporary directory and OpenKnowledge home are on different filesystems. Runtime archives are staged beside their destination for an atomic same-filesystem rename, and concurrent launches adopt an already completed install instead of removing it.
