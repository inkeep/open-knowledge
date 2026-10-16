---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
---

Stop OpenKnowledge's saved version history from growing without bound when your project's `.git` resolves to a directory inside the project, such as a `.git.nosync` symlink or a separate git directory. That directory is now kept out of every new version.
