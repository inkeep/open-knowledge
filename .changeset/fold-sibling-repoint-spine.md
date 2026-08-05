---
'@inkeep/open-knowledge': patch
---

Skill relocation now runs a single sibling symlink re-point spine. The promote path's placement-ledger sweep was a hand-maintained second copy that claimed a narrower set of links and wrote link targets by a different rule; it now routes through the same helper as the host-dir sweep. A recorded placement that pointed at the old source is re-pointed directly at the new one instead of being left chained through it.
