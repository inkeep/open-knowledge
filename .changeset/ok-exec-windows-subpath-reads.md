---
"@inkeep/open-knowledge": patch
---

Fix the `exec` MCP tool being unable to read any file below the project root on
Windows. `cat`, `ls`, `grep`, and `find` against a subpath (e.g. `cat notes/x.md`)
returned "No such file or directory" even though the file existed, because the
bundled `just-bash` sandbox judged every backslash-separated Windows path as
"outside sandbox". Bumping `just-bash` to the release that handles Windows path
separators restores subpath reads/listings; only genuinely-absent files now
report ENOENT. macOS and Linux are unaffected.
