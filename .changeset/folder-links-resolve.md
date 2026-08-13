---
'@inkeep/open-knowledge': patch
---

Folder links now work like links. Clicking a wiki link or markdown link that targets an existing folder opens the folder view (the same destination the Links panel already used) instead of doing nothing, and the Problems tab no longer reports links to existing folders as dead — the link audit's existence oracles learned folders on both of its planes, and folder existence stays fresh as documents beneath a folder come and go. Links to folders that do not exist still report as dead links.
