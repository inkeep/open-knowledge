---
"@inkeep/open-knowledge": patch
---

`ok deinit` (and the per-project sweep in `ok uninstall`) now removes OK-installed skill projection symlinks (pack and authored skills under `.claude/skills/`, `.cursor/skills/`, etc.) instead of refusing them with "Refusing to write through a symbolic link" — removal unlinks the link itself and never touches its target. Dangling projection symlinks are cleaned up too; the refusal for symlinked ancestors that escape the project is unchanged.
