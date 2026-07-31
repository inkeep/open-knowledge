---
"@inkeep/open-knowledge": patch
---

Fixed path displays mangling Windows paths that resemble escape sequences. A folder such as `C:\Users\x64qa` rendered as `C:\Usersdqa` in the "Will be created at" caption (and any other message that shows a path), because the localization runtime decoded `\x`/`\u` escape sequences inside interpolated values. Decoding now applies only to the translated message text itself; values pass through verbatim. The actual files on disk were always created at the correct path — this was display-only.
