---
"@inkeep/open-knowledge": patch
---

On Windows, a project inside a git repository now correctly places `.ok/` at the repository root when the path contains a shortened folder name. Windows keeps a legacy short alias for most long folder names — `C:\Users\alexandra` is also reachable as `C:\Users\ALEXAN~1` — and the two spellings point at the same folder but read as different paths. OpenKnowledge compared the shortened form against the long form that git reports, concluded the repository was outside your home directory, and quietly skipped the promotion, leaving `.ok/config.yml` in the sub-folder you picked instead of at the repository root. Both spellings are now resolved to the same canonical path before the comparison, so the repository root is used as the project root as intended. Unaffected on macOS and Linux, which have no such aliases.
