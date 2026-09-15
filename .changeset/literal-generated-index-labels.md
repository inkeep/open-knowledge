---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-core': minor
---

Preserve generated-index metadata and folder labels as literal text. Labels containing Markdown punctuation may gain backslash escapes in machine-owned index files. On upgrade, changed enabled indexes are rewritten once; type labels that once rendered as the same heading remain separate. Remove the obsolete `headingContentIdentity` core export.
