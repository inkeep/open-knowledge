---
"@inkeep/open-knowledge": patch
---

Follow mode now flashes and scrolls to the agent's change even when it navigates you to the document *after* the write already landed — the common case that was silently doing nothing. Previously the scroll-and-flash only fired if the write arrived while you were already on that document; when following an agent across files, the tab would switch to each document and the edits would just "pop in" fully applied, with no highlight and no scroll. Agent writes now record which blocks they changed on the write-flash entry, so when follow mode brings a document into view the editor can still light up the changed section and scroll it into view. Writes you're already watching are unaffected (and never double-flash).
