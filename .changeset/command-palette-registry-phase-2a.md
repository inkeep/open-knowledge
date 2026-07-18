---
"@inkeep/open-knowledge": patch
---

Internal refactor of the Cmd+K command palette: the fixed command rows now render from a single command registry that also drives the palette/menu parity ratchets, replacing the per-command hand-wiring. No user-facing changes — the commands, their grouping, labels, shortcuts, and behavior are unchanged.
