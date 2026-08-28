---
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge': patch
---

Fixed a macOS auto-update failure that could leave OpenKnowledge missing from your Applications folder, and a "Check for Updates" dialog that named a version it was not going to install.

The app arms an update at download time and installs it when you quit. Underneath, Squirrel arms it by launching ShipIt, which then waits — with no timeout of its own — for the app to exit. Downloading a newer build did not replace that pending request, it armed a second ShipIt beside the first; both then woke in the same instant at quit and raced the same bundle swap. The loser moved aside the bundle the winner had just installed, and when it could not put it back the app was left missing from `/Applications` until a later restore.

On macOS a build already staged in this session is now installed as-is: newer offers are declined until the next session, including the freshness check on the "Relaunch now" click, and a manual check for updates says the staged build is ready rather than advertising the one it declined. Windows and Linux keep taking newer builds mid-session, because neither leaves a second installer armed: Windows runs whichever installer was downloaded last, and Linux arms nothing until you click relaunch.

Bug reports also collect the numeric-suffixed ShipIt logs (`ShipIt_stderr.log.1`, `.2`, …). Squirrel falls back to those when the base log is not writable, which is what happens once the log is owned by root — precisely the machines where a failing install is worth diagnosing.
