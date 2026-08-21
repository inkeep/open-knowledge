---
"@inkeep/open-knowledge": patch
---

Follow-the-file no longer yanks the editor to an ACP agent's presence `currentDoc` when the write happened minutes ago. The 3-second keepalive was refreshing `entry.ts` past the 5-second staleness guard even when the doc itself hadn't been touched. Presence entries now carry a separate `docTs` set only when `currentDoc` is written, and the client staleness check reads that instead.
