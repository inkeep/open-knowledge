---
"@inkeep/open-knowledge": minor
---

Opening a share link no longer drops you into an empty "start writing" editor when the shared doc isn't on your checkout — the trap where typing would silently fork a new doc at the shared path. When a share-receive navigation lands on a target your branch doesn't carry, the editor now renders an honest panel that checks GitHub and explains what happened: your local copy is just behind (pull to get it), the doc moved (open it at its new path), it was removed, or it was never pushed to the branch. Each panel offers a Browse folder escape to the parent folder, and the check falls back to today's pull guidance when GitHub can't be reached. Ordinary in-app navigation (wiki links) still creates a new page on navigate as before.
