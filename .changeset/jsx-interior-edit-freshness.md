---
"@inkeep/open-knowledge": patch
---

Editing inside a Callout, tab, accordion, or table cell in the visual editor now always reaches collaborators and reopens with exactly the content you see. Previously the editor could hold a cached copy of a component's original source and, when the inside was edited, serialize those stale bytes for everyone else — your own editor looked right while a teammate (or a fresh reopen) got the pre-edit content, or in rare cases structurally-broken markdown. The server now re-derives a component's markdown whenever its live contents diverge from that cached source, regardless of which surface made the edit, so what you see is what everyone gets. A drain-time legality check backs this up: if a serialization would still lose content, it is caught at the moment the bytes are written and a recoverable snapshot is kept instead of shipping the corruption.
