---
"@inkeep/open-knowledge": patch
---

Edits typed while the connection drops are no longer lost when the document recycles

Typing right after the editor lost its server connection (for example after switching windows) could silently destroy that edit: a short debounce timer recycles idle disconnected documents, and it only checked for unsynced edits when it was armed, not when it fired. An edit typed inside that window rode into the teardown; if the server identity changed before the next sync (an app update relaunch does exactly this), the edit was gone permanently. The recycle now re-checks for unsynced edits at fire time and leaves dirty documents alone, and the server-restart recovery replays a preserved edit at content level so it also survives a server identity change instead of being parked as an unresolvable CRDT delta.
