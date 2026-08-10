---
'@inkeep/open-knowledge': patch
---

Platform-correct copy now that the desktop app ships on Windows and Linux. In the app, `Reveal in Finder` becomes `Reveal in File Explorer` on Windows and `Open containing folder` on Linux across the menus, command palette, and sidebar; Windows reads `Move to Recycle Bin` (and "restore from the Recycle Bin") where macOS and Linux keep `Move to Trash`; and the bug-report dialogs say "this computer" instead of "this Mac". `ok bug-report` now reveals the finished bundle in your file manager on Windows and Linux too (previously macOS-only, silently skipped elsewhere), and `ok uninstall` detects Windows and Linux desktop installs and prints the right removal step for each platform. The docs site, share-link splash, and downloads page now cover the Windows and Linux apps — including the share splash no longer claiming OpenKnowledge isn't supported on Windows.
