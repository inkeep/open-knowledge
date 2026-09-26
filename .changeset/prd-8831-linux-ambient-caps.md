---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

On Linux, the desktop app no longer crashes when a native dialog or other system UI loads icons inside a container that grants extra capabilities, such as x11docker with `--cap-add`. The reported trigger was the folder picker.
