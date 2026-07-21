---
"@inkeep/open-knowledge": minor
---

Fold agent threads into one unified sessions dock. Terminals and in-app AI agents now live as tabs in a single dock instead of two competing right-edge columns — one tab strip, one reveal tab, one ⌘J toggle, one mental model. A shell and an agent are just tabs of a different kind: each carries a kind icon (a shell glyph, or the agent's avatar with a live status dot), and reorder, activate, rename, and close work the same across both, with behavior dispatched by kind (closing a terminal kills its shell; closing an agent archives the conversation, recoverable from history).

The dock is now host-agnostic: it renders in the browser too (agent tabs only there), so web users get the same docked, resizable, right-or-bottom placement the desktop terminal already had. The "New" split button merges every launch into one menu — your registered agents, "Choose another agent" to browse the catalog, and (on desktop) every CLI plus a bare terminal — and its primary button repeats your last pick across all three families. Launching an agent from an "Open with AI" menu opens a tab in this one dock and reveals it automatically. Conversation history moves with it: a history menu next to "New" (and a chooser on an empty dock) reopens or permanently deletes past conversations, so closing a thread archives it rather than losing it.

A full renderer reload now restores the dock's interleaved tab order and which tab was active, alongside the terminals and agent threads it already recovered. The standalone macOS terminal window is unchanged (terminals only). No settings, shortcuts, or stored preferences change.
