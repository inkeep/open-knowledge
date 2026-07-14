---
'@inkeep/open-knowledge': patch
---

External links now reliably open in your OS default browser on desktop.
Clicking an http(s) link in the visual editor, source mode, or a wiki-link
chip previously could open another Open Knowledge window rendering the page
— most visibly in windows created after a server restart. Link clicks now
route straight through the desktop bridge, and the window-level safety net
is attached to every editor window (including the server-restart recreate
path), so external URLs land in your browser everywhere. Web behavior is
unchanged (links still open in a new tab).
