---
"@inkeep/open-knowledge": patch
---

Agent tabs are easier to tell apart. Three changes to the tab strip:

- **Unread indicator.** A settled `ready` tab whose transcript advanced while you were on a different tab now pulses its status dot until you click into it — no more "did that other agent finish yet?" polling.
- **Per-thread identity.** Every thread gets a stable, hashed tint ring around its agent icon, so a row of Claude tabs isn't just "same icon, truncated title" — each thread has a persistent visual anchor.
- **Better auto-titles.** The tab title now strips a leading agent-name *address* (`Claude, what's 2+2?` → `What's 2+2?`, but `Codex is failing to start` passes through unchanged), plus punctuation the prompt itself opens with (`— refactor the parser` → `Refactor the parser`), so the distinguishing words land at the start of the label.
