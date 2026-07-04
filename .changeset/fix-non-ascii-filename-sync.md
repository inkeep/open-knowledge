---
"@inkeep/open-knowledge": patch
---

Fix git sync mishandling files whose names contain non-ASCII characters (e.g. `ä`, `ö`, `å`, accents, CJK). Git quotes such names in its output (`"hyv\303\244\303\244 y\303\266t\303\244.md"`), and the sync engine reused that escaped string as a literal path, so:

1. Deleting a non-ASCII-named file was never committed — the deletion silently failed to sync on every cycle, forever, until the file was removed manually with `git rm`.
2. A merge conflict on a non-ASCII-named file was misclassified and could abort the merge and pause sync instead of surfacing the conflict for resolution.
3. Auto-save commit messages and the conflict list showed the escaped gibberish instead of the real filename.

Git path output is now read NUL-separated (`-z`), so filenames round-trip as real UTF-8 everywhere the server parses paths: the sync push/delete cycle, conflict detection and resolution, dirty-file overlap checks before branch switches, and skill version restore.
