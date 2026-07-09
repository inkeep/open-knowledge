---
"@inkeep/open-knowledge": patch
---

Fix "clone to a new folder" (Open shared document) failing with `Use of "EDITOR" is not permitted without enabling allowUnsafeEditor` for anyone who has `EDITOR` or `GIT_EDITOR` set in their environment — i.e. most developers. `ok clone` runs git as the user with the user's own environment, and simple-git 3.36 refuses to run when it sees an editor env var present (it checks presence, not value) unless explicitly told the env is trusted. The clone path already opted into the sibling PAGER / SSH / askpass flags for the same reason; this adds the missing `allowUnsafeEditor` opt-in. A clone never launches an editor, so honoring the env is safe.

Also hardens the background sync path: the server's `git merge` now runs with `GIT_MERGE_AUTOEDIT=no`, so a merge commit can never launch an editor and hang the TTY-less sync process.
