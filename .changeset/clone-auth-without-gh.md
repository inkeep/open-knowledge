---
"@inkeep/open-knowledge": patch
---

Opening a shared document by cloning from GitHub no longer requires the GitHub CLI (`gh`) to be installed. OpenKnowledge now authenticates the clone with the GitHub account you're already connected as, rather than delegating to `gh` or to whatever credential helper your machine's git config happens to point at. "Clone to a new folder" previously failed on a clean machine — or one with a leftover `gh auth setup-git` config after `gh` was removed — with `gh: command not found` and `could not read Username`; it now uses your connected account directly.
