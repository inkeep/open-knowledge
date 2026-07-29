---
"@inkeep/open-knowledge": patch
---

Pasting a copy of an entire document no longer makes the paste disappear. Selecting all, copying, and pasting produces a document that is an exact doubling of what was just saved, which is the same shape a stale browser cache produces when it merges an old copy back in. The persistence guard that watches for that corruption could not tell the two apart, so about two seconds after the paste it refused to save and rolled the open document back to the copy on disk. The pasted content vanished from under the cursor, and undo could not bring it back because the rollback arrives as a remote change that neither the server nor the editor tracks as undoable.

The guard now distinguishes the two cases by when the doubling appears. A stale-cache merge shows up as soon as the document syncs, before the session has saved anything; a paste is an edit on a document that has already saved cleanly. Pastes are left alone and save normally. When the guard does still act on a genuine corruption, it now writes a recovery checkpoint of the pre-rollback document first, so that version stays restorable from version history instead of being lost.
