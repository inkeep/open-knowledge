---
'@inkeep/open-knowledge': patch
---

Warn before symlinking two skills folders whose contents differ. Picking a folder to symlink now previews the merge first and states exactly what it moves and what it deletes, including the harness dot-entries (Codex's `.system`) that go away with the folder. Folders holding the same skills still link in one click, and the two refusals — differing versions of the same skill, non-skill entries — are reported before the write instead of as a red toast after it.
