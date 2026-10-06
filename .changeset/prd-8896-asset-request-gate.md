---
"@inkeep/open-knowledge": patch
---

Raw asset requests whose path contains `#`, an encoded slash, a backslash, or a `.`, `..` or empty segment now return 404 for any file. Ignored files can no longer be reached this way, and files with a backslash in their name are no longer served on macOS or Linux.
