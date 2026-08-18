---
"@inkeep/open-knowledge": patch
---

ACP binary agents now install correctly when the temporary directory and OpenKnowledge home are on different filesystems. Binary archives are staged beside their destination for an atomic same-filesystem rename, and concurrent launches adopt an already completed install. Installs also retry the final rename when a Windows antivirus or indexer briefly holds the extracted files open, remember a broken manifest for a day instead of re-downloading the archive on every launch attempt, and sweep lock files left behind by crashed installers.
