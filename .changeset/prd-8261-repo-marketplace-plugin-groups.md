---
"@inkeep/open-knowledge": patch
---

Skills served by a plugin the repo itself declares (a `.claude-plugin/marketplace.json` with in-tree plugin sources) now group under that plugin in every checkout of the repo. Grouping previously depended on the editor's plugin registry, which records installs per absolute path, so a second clone of the same repo showed those skills as a flat, ungrouped list. The repo manifest is now read directly, so the identity no longer depends on where the clone lives or whether the editor has registered it.
