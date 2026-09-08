---
"@inkeep/open-knowledge": patch
---

A document that fails to load now retries itself instead of staying on the error screen.

When a document's first sync timed out or its connection dropped, it showed "Couldn't load document" and stayed there for the life of the window — nothing retried it, even once the connection came back and every other document was opening normally. The only way out was Try again, Go back, or a restart.

The editor now retries such a document on its own, on the same path the Try again button takes, as soon as the connection reports that the document is in sync. It tries at most three times, and if the document still will not load it leaves the error screen up with its buttons rather than looping. Errors that a retry cannot fix — a document that does not exist, a server that cannot open documents, a load you cancelled — are not retried at all.

The "Connected, but your edits aren't reaching the server yet" warning now names the document it is about, so a single stuck document no longer reads as a claim about the whole session.
