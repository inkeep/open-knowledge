---
'@inkeep/open-knowledge': patch
---

The Undo button now works after accepting a hunk while resolving a merge conflict. Previously it did nothing once you had used Accept — only Reject could be undone — so a mis-clicked Accept was unrecoverable without exiting the merge and starting the resolution over. Undo also no longer steps out of order: in a session mixing Reject and Accept, it walks back through your resolutions newest-first instead of skipping past the accepts and silently reverting an earlier reject you were no longer looking at.
