---
"@inkeep/open-knowledge": patch
---

Fixes a bug where a document could drop into a merge-conflict state, replacing the editor with the conflict diff view, even though nothing outside Open Knowledge had touched the file.

Before writing to a document, the server compares what is on disk against what it believes it last wrote, so that a write from another program is detected but its own recent save is not mistaken for one. That check only remembered a single save per document. When an agent write and your typing kept a document busy enough that two saves were in flight at once, the second save displaced the record of the first, the still-settling first save on disk no longer matched anything the server recognized, and it was treated as a foreign edit. The three-way merge that followed compared the document against its own earlier save and, when both had changed the same paragraph, reported a conflict that never existed. The editor was then swapped for the conflict resolution view and later agent writes were refused with a 409 until the phantom conflict was resolved.

The server now tracks every save still in flight for a document rather than only the most recent one, the way the file watcher already recognizes its own writes. Those records expire after a minute and are treated as absent by everything that reads them, so a save that never reports completion cannot quietly disable the background durability check for that document. Detection of genuine external edits is unchanged: a write from another program is still reconciled unless it is byte-for-byte a save Open Knowledge is already making.

Separately, the background check that rescues documents whose edits never reached disk no longer waits forever on a single save. If one document's write stops responding, that document is set aside and reported instead of stalling the check for every other open document until the app is restarted. It is picked up again as soon as that write finishes, whichever way it finishes, so a save that hangs and then fails on a network or cloud-synced folder no longer leaves that document unprotected for the rest of the session.
