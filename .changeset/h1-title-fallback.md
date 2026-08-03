---
"@inkeep/open-knowledge": patch
---

A document with no `title:` in its frontmatter now takes its title from the first `# heading` in the body, falling back to the path only when there is no heading either. Agent-facing listings (`exec cat`, `exec ls`, the "most recent" line on a directory) were showing raw paths for files that plainly announce their own title on line one, which is the normal shape for vaults, imported notes, and simple logs. `/api/pages` and workspace search already resolved titles this way, so this brings the enrichment surface in line with the rest of the app, down to the details: a `title:` is trimmed, and a blank or whitespace-only one now counts as no title and falls through to the heading rather than showing as an empty label.
