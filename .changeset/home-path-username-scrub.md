---
"@inkeep/open-knowledge": patch
---

Bug reports no longer carry your account name when a path stops at your home folder. Diagnostic bundles replace the path to your user folder with `~`, and until now that only worked when something followed the folder in the text. A log line or a note ending at the folder itself, which is the most common way it appears, went out with the account name intact on Windows, macOS and Linux alike. Those are now replaced too, and a line carrying two such paths now has both replaced where before the second one survived.
