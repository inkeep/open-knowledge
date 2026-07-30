---
"@inkeep/open-knowledge": minor
---

Documents no longer get permanently stuck offline after the server restarts. Previously, if the restart took more than a couple of seconds, an open document could land in a state where it reconnected forever without ever syncing: the banner said "Connection lost, keep this tab open, your edits will sync when reconnected", but nothing it promised was going to happen. Switching to another document and back did not help, and anything typed while stuck was lost on reload. The client now treats a restarted server the same way whichever way it finds out about it, so the affected documents recover on their own and the edits typed during the outage are replayed instead of dropped.
