---
"@inkeep/open-knowledge": patch
---

Follow-the-file no longer opens a blank "create-on-open" tab for a document the agent never actually worked on. A read/search/exec tool call whose newest file location resolves to a doc that does not exist (for example a git branch name or a path echoed from the prompt, like the phantom `main` tab) is now ignored — matching the existing gate on `exec`/shell command reads. Edits and other write-shaped targets stay ungated because they legitimately name docs that are about to be created.
