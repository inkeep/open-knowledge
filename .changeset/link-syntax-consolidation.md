---
"@inkeep/open-knowledge": patch
---

Consolidate the server's inline link recognizers (backlink index, rename rewriting, link suggestions, referenced-asset scanning) onto one shared grammar, so a link that counts for backlinks can no longer be silently missed by rename rewriting or the asset sidebar. The backlink/rename grammar is the canonical one; the asset scanner picks up small correctness fixes from the alignment: links with parenthesized titles (`[doc](file.pdf (title))`) and titles containing the other quote character (`[doc](file.pdf "it's here")`) now count as asset references, malformed mismatched-quote titles no longer do, and wiki-link targets are trimmed before resolution.
