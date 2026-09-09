---
"@inkeep/open-knowledge": patch
---

The editor now says what happened to your unsynced edits when the server restarts.

If the collaboration server restarted while a document was open, the client's recovery path had six ways to end without writing a word to the log: the buffered edit could be replayed, discarded, found empty, or never looked at, and all four looked the same from outside. Reporting "my edit vanished after a restart" was therefore as far as anyone could get — there was no way to tell whether the edit had been captured, whether the replay ran, or which step let it go.

Each of those exits is now named on the log, and closing a document records which part of the app asked for it. Nothing about how edits are recovered has changed; this only makes the existing behaviour visible.
