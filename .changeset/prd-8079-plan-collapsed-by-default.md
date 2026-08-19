---
"@inkeep/open-knowledge": patch
---

The `Plan (n/m)` header in the ACP transcript now starts collapsed instead of expanded. Plans routinely run to twenty items, and an always-open default buried the running transcript below the fold and gave users no obvious way to reclaim the space (the click zone is one narrow row — easy to miss, easy to think dead). Click the header once to open the list; click again to close it. Extracted the block to its own `PlanChecklist.tsx` file with `data-testid` hooks and DOM coverage for the toggle, the prop-update path (plan stream ticks must not close the drawer someone just opened), and completed-item styling.
