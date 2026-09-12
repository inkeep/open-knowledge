---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
"@inkeep/open-knowledge-server": patch
---

`ok ps`, `ok stop`, and `ok uninstall` no longer stall for seconds while inspecting running processes, and neither does the desktop uninstall flow. A process that stops responding is queried twice, each attempt bounded at two seconds, so it still adds to the inspection.
