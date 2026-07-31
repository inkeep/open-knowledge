---
"@inkeep/open-knowledge": patch
---

Declared three missing runtime dependencies in the Linux `.deb` package (`libasound2`, `libcups2`, `libgbm1`). All three are directly linked by the app binary but were absent from the package's dependency list, so on a minimal system the package installed successfully and the app then failed to start with no window and no error dialog. Systems that already have these libraries (most desktop installs) were unaffected.
