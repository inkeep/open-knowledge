---
'@inkeep/open-knowledge': patch
---

The Timeline no longer reports "History unavailable", and a folder's timeline card no longer disappears, on branches whose names contain characters git accepts but the history endpoint used to reject.

A branch named `worktree-design+atc-release-package` used to get a 400 from `/api/history`, which the document Timeline rendered as "History unavailable" and a folder's timeline card rendered as nothing at all — the card was simply absent from the folder overview, with no message. `feature-café` and fully non-Latin branch names were rejected the same way. Twenty-one printable-ASCII characters real branch names may contain — `+`, `%`, `#`, `=`, `&`, `!`, `$`, `(`, `)`, `,`, `;`, `'` and others — plus every non-ASCII character and any leading underscore are now served.

Both surfaces also now log the server's problem type and title to the browser console when a history request fails, so a Timeline that will not load says why.

One class is still rejected: the shared rules refuse any whitespace, including non-ASCII whitespace such as a non-breaking space, which git itself does allow. A branch named that way still gets a 400 and a dead Timeline.
