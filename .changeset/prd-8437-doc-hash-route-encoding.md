---
'@inkeep/open-knowledge': patch
---

Documents and folders whose name contains `#`, `?` or `%` are addressable again.
Opening one used to mint a New Tab, drop the tab on restart, and leave the
sidebar without a selection, because the route hash was built with the name
unescaped and the first `#` was then read as a section anchor.
